export interface ProjectFile {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface JobConfig {
  name: string;
  samples: number;
  strategy: 'single' | 'random' | 'exhaustive';
  templatePath: string;
  dataPath?: string;
  dataCollection?: string;
  host: string;
  model: string;
  outputMode: 'unstructured' | 'json' | 'schema';
  schemaPath?: string;
  temperature: number;
  maxTokens: number;
  thinkingBudget?: number;
  preRenderUrl?: string;
  preRenderJson?: string;
}

export interface Job {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  config: JobConfig;
  collectionName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Sample {
  id: string;
  jobId: string;
  status: 'pending' | 'streaming' | 'completed' | 'error';
  prompt: string;
  response?: string;
  parsed?: unknown;
  error?: string;
  latencyMs?: number;
  tokens?: number;
  createdAt: string;
}

export interface Collection {
  id: string;
  name: string;
  schema?: object;
  createdAt: string;
}

export interface CollectionItem {
  id: string;
  collectionId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ActionConfig {
  sourceCollection: string;
  scriptPath: string;
  targetCollection: string;
}

export interface PipelineStage {
  id: string;
  type: 'job' | 'action' | 'agent';
  ref: string; // path or id
  config?: Record<string, unknown>;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  status: 'draft' | 'running' | 'completed' | 'error';
  createdAt: string;
}

export interface AgentConfig {
  name: string;
  pipelineId?: string;
  queries: string[];
  targetCollection?: string;
}

export interface AgentRun {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  createdAt: string;
}
