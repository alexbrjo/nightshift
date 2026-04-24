// Shared types between main and renderer processes

export interface Project {
  id: string
  path: string
  name: string
  createdAt: number
  updatedAt: number
  settings: ProjectSettings
}

export interface ProjectSettings {
  defaultModel?: string
  defaultProvider?: string
  apiEndpoint?: string
}

// ─── Inference Job Types ───────────────────────────────────────────────

export type SamplingStrategy = 'single' | 'random' | 'exhaustive'
export type OutputMode = 'unstructured' | 'plain-json' | 'schema-validated'
export type JobStatus = 'pending' | 'running' | 'completed' | 'errored' | 'cancelled'

export interface InferenceJobConfig {
  name: string
  samplingStrategy: SamplingStrategy
  numSamples?: number
  templateFile: string
  sourceData: SourceData
  apiEndpoint: string
  modelName: string
  outputMode: OutputMode
  temperature?: number
  maxTokens?: number
  thinkingBudget?: number
  preRenderUrl?: string
  preRenderJson?: Record<string, unknown>
  schemaFile?: string
}

export interface SourceData {
  type: 'file' | 'collection'
  path?: string       // for file type
  collectionName?: string  // for collection type
}

export interface InferenceJob extends InferenceJobConfig {
  id: string
  status: JobStatus
  createdAt: number
  updatedAt: number
  totalSamples: number
  completedSamples: number
  erroredSamples: number
  resultsCollection?: string
}

export interface JobSampleResult {
  id: string
  jobId: string
  sampleIndex: number
  status: 'streaming' | 'completed' | 'errored'
  renderedPrompt?: string
  rawResponse?: string
  parsedContent?: Record<string, unknown>
  error?: string
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  latencyMs?: number
  createdAt: number
}

// ─── Collection Types ──────────────────────────────────────────────────

export interface CollectionSchema {
  name: string
  columns: ColumnDefinition[]
  createdAt: number
  updatedAt: number
}

export interface ColumnDefinition {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
}

// ─── Bulk Action Types ─────────────────────────────────────────────────

export interface BulkActionConfig {
  id: string
  name: string
  sourceCollection: string
  targetCollection: string
  scriptFile: string
  createdAt: number
  status: 'pending' | 'running' | 'completed' | 'errored'
}

// ─── Pipeline Types ────────────────────────────────────────────────────

export type PipelineStageType = 'inference' | 'javascript-action' | 'analysis-agent'

export interface PipelineStage {
  id: string
  pipelineId: string
  order: number
  stageType: PipelineStageType
  name: string
  // For inference stages
  jobId?: string
  // For JS action stages
  actionId?: string
  // For analysis agent stages
  agentConfigId?: string
  // Shared input/output mapping (Jinja2-style)
  inputMapping?: Record<string, string>
  outputCollection?: string
}

export interface ExperimentGroup {
  id: string
  name: string
  parameters: Record<string, unknown>
}

export interface Pipeline extends Omit<PipelineStage, 'pipelineId'> {
  id: string
  name: string
  stages: PipelineStage[]
  experimentGroups?: ExperimentGroup[]
  status: 'draft' | 'running' | 'completed' | 'errored'
  createdAt: number
  updatedAt: number
}

export interface PipelineRun {
  id: string
  pipelineId: string
  groupId?: string
  status: 'pending' | 'running' | 'completed' | 'errored'
  startedAt: number
  completedAt?: number
  stageResults: Record<string, StageRunResult>
}

export interface StageRunResult {
  stageId: string
  status: 'pending' | 'running' | 'completed' | 'errored'
  inputCount: number
  outputCount: number
  startedAt: number
  completedAt?: number
  error?: string
}

// ─── Analysis Agent Types ──────────────────────────────────────────────

export interface AnalysisAgentConfig {
  id: string
  name: string
  description?: string
  analysisQueries?: string[]
  summaryTemplate?: string
  outputCollection?: string
  createdAt: number
}

export interface AgentRunResult {
  runId: string
  analysisQueries?: Record<string, unknown>[]
  anecdotes?: string[]
  summary: string
  proofreadNotes?: string[]
  exportedAt?: number
}

// ─── IPC Message Types ─────────────────────────────────────────────────

export interface IpcMessage<T = unknown> {
  type: string
  payload: T
}
