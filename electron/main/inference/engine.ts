import { readFileSync } from 'fs'
import { join } from 'path'
import OpenAI from 'openai'
import nunjucks from 'nunjucks'
import { z } from 'zod'
import type { DbConnection } from '../db/database'
import {
  createJobSampleResult,
  incrementCompletedSamples,
  incrementErroredSamples,
  updateJobStatus,
} from '../db/database'
import { readProjectFile } from '../filesystem/fileService'
import { HTTP_TIMEOUT_MS, MAX_RESPONSE_SIZE_BYTES } from '@shared/constants'

// ─── Zod schemas for validation ────────────────────────────────────────

const JobConfigSchema = z.object({
  name: z.string().min(1),
  samplingStrategy: z.enum(['single', 'random', 'exhaustive']),
  numSamples: z.number().int().positive().optional(),
  templateFile: z.string().min(1),
  sourceDataType: z.enum(['file', 'collection']),
  sourceDataPath: z.string().optional(),
  sourceDataCollection: z.string().optional(),
  apiEndpoint: z.string().url(),
  modelName: z.string().min(1),
  outputMode: z.enum(['unstructured', 'plain-json', 'schema-validated']),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(4096),
  thinkingBudget: z.number().optional(),
  preRenderUrl: z.string().url().optional(),
  preRenderJson: z.record(z.unknown()).nullable().optional(),
  schemaFile: z.string().optional(),
})

// ─── Sampling strategies ───────────────────────────────────────────────

interface SampleInput {
  index: number
  data: Record<string, unknown>
}

function sampleInputs(inputs: Record<string, unknown>[], strategy: string, numSamples?: number): SampleInput[] {
  const indices = inputs.map((data, i) => ({ index: i, data }))

  switch (strategy) {
    case 'single': {
      const target = numSamples ?? 1
      return indices.slice(0, Math.min(target, indices.length))
    }
    case 'random': {
      const count = numSamples ?? Math.min(10, indices.length)
      const shuffled = [...indices].sort(() => Math.random() - 0.5)
      return shuffled.slice(0, Math.min(count, shuffled.length))
    }
    case 'exhaustive':
    default:
      return indices
  }
}

// ─── Template rendering ────────────────────────────────────────────────

function renderTemplate(template: string, variables: Record<string, unknown>): string {
  nunjucks.configure({ autoescape: false })
  return nunjucks.renderString(template, variables)
}

// ─── Output parsing ────────────────────────────────────────────────────

function parseOutput(content: string, mode: string, schema?: z.ZodType<unknown>): { parsedContent?: Record<string, unknown>; error?: string } {
  switch (mode) {
    case 'unstructured':
      return { parsedContent: { raw: content } }
    case 'plain-json': {
      try {
        const parsed = JSON.parse(content)
        return { parsedContent: typeof parsed === 'object' && parsed !== null ? parsed : { raw: content } }
      } catch {
        return { error: `Failed to parse response as JSON: ${content.slice(0, 200)}` }
      }
    }
    case 'schema-validated': {
      if (!schema) {
        return { error: 'Schema validation requested but no schema provided' }
      }
      try {
        const parsed = JSON.parse(content)
        const result = schema.safeParse(parsed)
        if (result.success) {
          return { parsedContent: result.data as Record<string, unknown> }
        }
        return { error: `Schema validation failed: ${result.error.message}` }
      } catch {
        return { error: 'Failed to parse response as JSON for schema validation' }
      }
    }
    default:
      return { parsedContent: { raw: content } }
  }
}

// ─── Schema loading ────────────────────────────────────────────────────

function loadSchema(schemaFile?: string): z.ZodType<unknown> | undefined {
  if (!schemaFile) return undefined
  try {
    const schemaStr = readFileSync(schemaFile, 'utf-8')
    const schemaObj = JSON.parse(schemaStr)
    return jsonSchemaToZod(schemaObj) as z.ZodType<unknown>
  } catch {
    return undefined
  }
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType<unknown> {
  if (!schema.type) return z.record(z.unknown())

  switch (schema.type) {
    case 'string':
      return z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array': {
      const itemsSchema = schema.items ? jsonSchemaToZod(schema.items as Record<string, unknown>) : z.unknown()
      return z.array(itemsSchema)
    }
    case 'object': {
      if (!schema.properties) return z.record(z.unknown())

      const shape: Record<string, z.ZodType<unknown>> = {}
      for (const [key, prop] of Object.entries(schema.properties as Record<string, unknown>)) {
        const propSchema = jsonSchemaToZod(prop as Record<string, unknown>)
        const requiredArr = schema.required as string[] | undefined
        const required = requiredArr?.includes(key) ?? false
        shape[key] = required ? propSchema : propSchema.optional()
      }
      return z.object(shape)
    }
    default:
      return z.record(z.unknown())
  }
}

// ─── Main inference engine ─────────────────────────────────────────────

export class InferenceEngine {
  private db: DbConnection['db']

  constructor(db: DbConnection['db']) {
    this.db = db
  }

  async runJob(jobId: string, projectPath: string): Promise<void> {
    updateJobStatus(this.db, jobId, 'running')

    // Fetch job config from DB
    const jobRow = this.db.prepare('SELECT * FROM inference_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!jobRow) throw new Error(`Job not found: ${jobId}`)

    // Validate config — preprocess null/empty values to undefined so .optional() skips validation
    const safeStr = (v: unknown): string | undefined => {
      if (v == null || (typeof v === 'string' && v.trim() === '')) return undefined
      return v as string
    }
    const safeNum = (v: unknown): number | undefined => (v == null ? undefined : v as number)

    const config = JobConfigSchema.parse({
      name: jobRow.name,
      samplingStrategy: jobRow.sampling_strategy,
      numSamples: safeNum(jobRow.num_samples),
      templateFile: join(projectPath, jobRow.template_file as string),
      sourceDataType: jobRow.source_data_type,
      sourceDataPath: jobRow.source_data_path ? join(projectPath, jobRow.source_data_path as string) : undefined,
      sourceDataCollection: safeStr(jobRow.source_data_collection),
      apiEndpoint: jobRow.api_endpoint,
      modelName: jobRow.model_name,
      outputMode: jobRow.output_mode,
      temperature: jobRow.temperature,
      maxTokens: jobRow.max_tokens,
      thinkingBudget: safeNum(jobRow.thinking_budget),
      preRenderUrl: safeStr(jobRow.pre_render_url),
      preRenderJson: jobRow.pre_render_json ? JSON.parse(jobRow.pre_render_json as string) : undefined,
      schemaFile: jobRow.schema_file ? join(projectPath, jobRow.schema_file as string) : undefined,
    })

    // Load template
    const relativeTemplate = config.templateFile.replace(projectPath + '/', '')
    const template = readProjectFile(projectPath, relativeTemplate)

    // Load source data
    let inputs: Record<string, unknown>[] = []
    if (config.sourceDataType === 'file' && config.sourceDataPath) {
      const relativePath = config.sourceDataPath.replace(projectPath + '/', '')
      const content = readProjectFile(projectPath, relativePath)
      inputs = this.parseSourceData(content)
    } else if (config.sourceDataType === 'collection') {
      // Fetch from collection - simplified for now
      inputs = []
    }

    if (inputs.length === 0) {
      updateJobStatus(this.db, jobId, 'completed')
      return
    }

    const sampledInputs = sampleInputs(inputs, config.samplingStrategy, config.numSamples)
    const schema = loadSchema(config.schemaFile)

    // Create OpenAI client with timeout and size limits
    const client = this.createClient(config.apiEndpoint)

    // Process each sample
    for (const { index, data } of sampledInputs) {
      try {
        const startTime = Date.now()

        // Render template with input data as variables
        const renderedPrompt = renderTemplate(template, { ...data, _index: index })

        // Build messages for the API call
        const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
          { role: 'user', content: renderedPrompt },
        ]

        // Add pre-rendered context if provided (RAG)
        if (config.preRenderUrl && config.preRenderJson) {
          messages.push({ role: 'system', content: JSON.stringify(config.preRenderJson, null, 2) })
        }

        // Call the LLM API
        const apiResponse = await client.chat.completions.create({
          model: config.modelName,
          messages,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          stream: false,
        })

        const choice = apiResponse.choices?.[0]
        const content = choice?.message?.content ?? ''
        const usageRaw = ((choice as unknown) as Record<string, unknown>)?.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
        const latencyMs = Date.now() - startTime

        // Parse output based on mode
        const { parsedContent, error } = parseOutput(content, config.outputMode, schema)

        // Save result
        createJobSampleResult(this.db, {
          jobId,
          sampleIndex: index,
          status: error ? 'errored' : 'completed',
          renderedPrompt,
          rawResponse: content,
          parsedContent: parsedContent ? JSON.stringify(parsedContent) : undefined,
          error,
          tokenUsage: usageRaw
            ? {
                promptTokens: usageRaw.prompt_tokens ?? 0,
                completionTokens: usageRaw.completion_tokens ?? 0,
                totalTokens: usageRaw.total_tokens ?? 0,
              }
            : undefined,
          latencyMs,
        })

        if (error) {
          incrementErroredSamples(this.db, jobId)
        } else {
          incrementCompletedSamples(this.db, jobId)
        }

        // Notify renderer of progress via IPC
        this.notifyProgress(jobId, index, error ? 'errored' : 'completed', latencyMs)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        createJobSampleResult(this.db, {
          jobId,
          sampleIndex: index,
          status: 'errored',
          error: `API call failed: ${errorMessage}`,
        })
        incrementErroredSamples(this.db, jobId)
        this.notifyProgress(jobId, index, 'errored')
      }
    }

    // Check if all samples are done and update final status
    const updatedJob = this.db.prepare('SELECT * FROM inference_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (updatedJob) {
      const totalDone = (updatedJob.completed_samples as number) + (updatedJob.errored_samples as number)
      const totalSamples = updatedJob.total_samples as number
      if (totalDone >= Math.max(totalSamples, 1)) {
        updateJobStatus(this.db, jobId, 'completed')
      }
    }

    this.notifyProgress(jobId, -1, 'done')
  }

  private createClient(endpoint: string): OpenAI {
    return new OpenAI({
      baseURL: endpoint,
      apiKey: process.env.NIGHTSHIFT_API_KEY || '',
      timeout: HTTP_TIMEOUT_MS,
      maxRetries: 2,
      // Custom fetch wrapper for response size limit
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init)

        // Check content length header
        const contentLength = response.headers.get('content-length')
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE_BYTES) {
          throw new Error(`Response exceeds maximum size of ${MAX_RESPONSE_SIZE_BYTES} bytes`)
        }

        return response
      },
    })
  }

  private parseSourceData(content: string): Record<string, unknown>[] {
    // Try JSON first (array or newline-delimited)
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) return parsed
      if (typeof parsed === 'object') return [parsed]
    } catch { /* fall through */ }

    // Try JSONL (newline-delimited JSON)
    const lines = content.split('\n').filter(l => l.trim())
    const results: Record<string, unknown>[] = []
    for (const line of lines) {
      try {
        results.push(JSON.parse(line))
      } catch { /* skip invalid lines */ }
    }

    return results
  }

  private notifyProgress(jobId: string, sampleIndex: number, status: string, latencyMs?: number): void {
    // IPC notification to renderer - handled by the main process IPC handler
    const event = { type: 'job-progress', payload: { jobId, sampleIndex, status, latencyMs } }
    console.log('[InferenceEngine]', JSON.stringify(event))
  }
}
