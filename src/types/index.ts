export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
}

export interface EditorState {
  filePath: string | null;
  content: string;
  unsaved: boolean;
  history: string[];
  historyIndex: number;
}

export type FileType = 'jinja' | 'json' | 'javascript' | 'csv' | 'yaml' | 'text';

export interface JobConfig {
  id: string;
  projectId: string;
  name: string;
  type: 'inference' | 'javascript';
  template?: string;
  templatePath?: string;
  inputFiles: string[];
  samplingStrategy: 'single' | 'random' | 'exhaustive';
  sampleSize?: number;
  // Inference-specific
  providerUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  outputFormat?: 'unstructured' | 'json' | 'schema-validated';
  jsonSchema?: string;
  schemaPath?: string;
  // JavaScript-specific
  script?: string;
  scriptPath?: string;
  status: 'pending' | 'running' | 'completed' | 'errored';
  progress: number;
  totalItems: number;
  completedItems: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobResult {
  id: string;
  jobId: string;
  inputIndex: number;
  status: 'pending' | 'streaming' | 'completed' | 'errored';
  renderedPrompt?: string;
  rawResponse?: string;
  parsedContent?: unknown;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs?: number;
  error?: string;
  createdAt: string;
}

export interface Collection {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  schemaPath?: string;
  itemCount: number;
  columns: ColumnDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface ColumnDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  path: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  type: 'inference' | 'javascript' | 'filter' | 'transform';
  config: Record<string, unknown>;
  inputSchema?: string;
  outputSchema?: string;
  position: { x: number; y: number };
}

export interface PipelineConnection {
  id: string;
  fromStageId: string;
  toStageId: string;
  fromOutput: string;
  toInput: string;
}

export interface Pipeline {
  id: string;
  projectId: string;
  name: string;
  stages: PipelineStage[];
  connections: PipelineConnection[];
  yamlDefinition?: string;
  status: 'draft' | 'trial' | 'running' | 'completed' | 'errored';
  trialResults?: TrialRunResult[];
  createdAt: string;
  updatedAt: string;
}

export interface TrialRunResult {
  stageId: string;
  batchIndex: number;
  status: 'pending' | 'running' | 'completed' | 'errored';
  results: unknown[];
  metrics?: Record<string, unknown>;
}

export interface AnalysisAgent {
  id: string;
  projectId: string;
  experimentId?: string;
  name: string;
  status: 'idle' | 'analyzing' | 'reviewing' | 'complete';
  currentStep: 'queries' | 'anecdotes' | 'summary' | 'review';
  findingsPath?: string;
  createdAt: string;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'errored';
export type AgentStep = 'queries' | 'anecdotes' | 'summary' | 'review';
