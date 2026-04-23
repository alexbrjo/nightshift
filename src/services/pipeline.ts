import type { CollectionItem } from '../types'

function localRenderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(variables[key] ?? ''))
}

export interface PipelineStageConfig {
  id: string
  type: 'inference' | 'js-action' | 'evaluation'
  name: string
  config: Record<string, unknown>
}

export interface ExecutionContext {
  currentIndex: number
  totalStages: number
  stageName: string
  onProgress?: (stageIndex: number, stageName: string, status: string) => void
}

export async function executeInferenceStage(
  providerConfig: Record<string, unknown>,
  inputData: Record<string, unknown>[],
  context: ExecutionContext,
  renderTemplateFn: (template: string, vars: Record<string, unknown>) => string = localRenderTemplate
): Promise<CollectionItem[]> {
  const results: CollectionItem[] = []

  for (let i = 0; i < inputData.length; i++) {
    context.onProgress?.(context.currentIndex, context.stageName, `Processing ${i + 1}/${inputData.length}`)

    const vars = inputData[i]
    const template = providerConfig.template as string
    const renderedPrompt = renderTemplateFn(template, vars)
    const startTime = Date.now()

    try {
      const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerConfig.apiKey}`
        },
        body: JSON.stringify({
          model: providerConfig.model,
          messages: [{ role: 'user', content: renderedPrompt }],
          temperature: providerConfig.temperature || 0.7,
          max_tokens: providerConfig.maxTokens || 1024
        })
      })

      const data = await response.json()
      const latencyMs = Date.now() - startTime
      const message = data.choices?.[0]?.message?.content || ''

      let parsedContent = message
      try {
        parsedContent = JSON.parse(message)
      } catch {
        // Keep as raw string if not valid JSON
      }

      results.push({
        id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        renderedPrompt,
        rawResponse: message,
        parsedContent,
        tokenUsage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0
        },
        latencyMs,
        status: 'completed'
      })
    } catch (error) {
      results.push({
        id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        renderedPrompt,
        rawResponse: '',
        parsedContent: null,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: Date.now() - startTime,
        status: 'errored',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return results
}

export async function executeJSActionStage(
  code: string,
  inputData: Record<string, unknown>[],
  context: ExecutionContext
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = []

  for (let i = 0; i < inputData.length; i++) {
    context.onProgress?.(context.currentIndex, context.stageName, `Running ${i + 1}/${inputData.length}`)

    try {
      const fn = new Function('data', `
        'use strict';
        return (function(data) {
          ${code}
        })(data)
      `)
      const result = await fn(inputData[i])
      results.push({ success: true, data: result })
    } catch (error) {
      results.push({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        input: inputData[i]
      })
    }
  }

  return results
}

export async function executeEvaluationStage(
  query: string,
  contextResults: Record<string, unknown>[],
  context: ExecutionContext
): Promise<{ findings: string; metrics: Record<string, number> }> {
  context.onProgress?.(context.currentIndex, context.stageName, 'Analyzing results...')

  await new Promise(resolve => setTimeout(resolve, 500))

  return {
    findings: `Analysis of ${contextResults.length} results completed.`,
    metrics: {
      totalProcessed: contextResults.length,
      successRate: contextResults.filter(r => r.success !== false).length / Math.max(1, contextResults.length)
    }
  }
}

export async function executePipeline(
  stages: PipelineStageConfig[],
  initialInput: Record<string, unknown>[],
  providerConfig: Record<string, unknown>,
  onProgress?: (stageIndex: number, stageName: string, status: string) => void
): Promise<{ outputs: Record<string, unknown>[]; summary: { stagesRun: number; totalItems: number } }> {
  let currentData = initialInput.map(item => ({ ...item }))
  const context: ExecutionContext = {
    currentIndex: 0,
    totalStages: stages.length,
    stageName: '',
    onProgress
  }

  for (let i = 0; i < stages.length; i++) {
    context.currentIndex = i
    context.stageName = stages[i].name

    const stageConfig = stages[i].config || {}

    switch (stages[i].type) {
      case 'inference': {
        const inferenceResults = await executeInferenceStage(
          { ...providerConfig, ...stageConfig },
          currentData,
          context
        )
        // Convert CollectionItem[] to Record for next stage
        currentData = inferenceResults.map(r => ({
          ...r.parsedContent as Record<string, unknown>,
          _rawResponse: r.rawResponse,
          _status: r.status,
          _error: r.error
        }))
        break
      }

      case 'js-action': {
        const code = stageConfig.code as string || ''
        if (code) {
          currentData = await executeJSActionStage(code, currentData, context)
        }
        break
      }

      case 'evaluation': {
        const query = stageConfig.query as string || 'Analyze the results'
        currentData = [await executeEvaluationStage(query, currentData, context)] as unknown as Record<string, unknown>[]
        break
      }
    }
  }

  return {
    outputs: currentData,
    summary: {
      stagesRun: stages.length,
      totalItems: initialInput.length
    }
  }
}