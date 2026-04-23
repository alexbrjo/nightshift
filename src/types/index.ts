export interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

export interface ProjectStore {
  id: string
  path: string
  collections: Collection[]
  jobs: Job[]
  pipelines: Pipeline[]
}

export interface Collection {
  id: string
  name: string
  createdAt: number
  items: CollectionItem[]
  schema?: JsonSchema
}

export interface CollectionItem {
  id: string
  renderedPrompt: string
  rawResponse: string
  parsedContent: unknown
  tokenUsage: TokenUsage
  latencyMs: number
  status: 'streaming' | 'completed' | 'errored'
  error?: string
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface JsonSchema {
  type: string
  properties?: Record<string, unknown>
  required?: string[]
}

export interface Job {
  id: string
  name: string
  templatePath: string
  inputFiles: string[]
  samplingStrategy: 'single' | 'random' | 'exhaustive'
  provider: LLMProvider
  outputFormat: 'unstructured' | 'json' | 'schema'
  schemaPath?: string
  status: 'pending' | 'running' | 'completed' | 'error'
  results: CollectionItem[]
}

export interface LLMProvider {
  type: 'openai-compatible'
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  thinkingBudget?: number
}

export interface Pipeline {
  id: string
  name: string
  stages: PipelineStage[]
  status: 'draft' | 'running' | 'completed'
}

export interface PipelineStage {
  id: string
  type: 'inference' | 'js-action' | 'evaluation'
  config: unknown
}
