export type SamplingStrategy = 'single' | 'random' | 'exhaustive';
export type OutputMode = 'unstructured' | 'plain_json' | 'json_schema';

export interface InferenceJobConfig {
  name: string;
  numSamples: number;
  samplingStrategy: SamplingStrategy;
  promptFile: string;
  sourceData: {
    type: 'file' | 'collection';
    path: string;
  };
  apiHostname: string;
  modelName: string;
  outputMode: OutputMode;
  temperature: number;
  tokenLimit: number;
  thinkingBudget: number;
  ragConfig?: {
    url: string;
    json: any;
  };
}

export interface InferenceJob {
  id: string;
  config: InferenceJobConfig;
  status: 'pending' | 'running' | 'completed' | 'errored';
  createdAt: number;
}

export interface BulkActionConfig {
  name: string;
  sourceCollectionId: string;
  targetCollectionId: string;
  scriptPath: string;
}

export interface BulkActionResult {
  id: string;
  actionName: string;
  status: 'pending' | 'running' | 'completed' | 'errored';
  createdAt: number;
}

export type PipelineStageType = 'inference-job' | 'bulk-action' | 'analysis-agent';

export interface PipelineStage {
  id: string;
  type: PipelineStageType;
  targetId: string; // ID of the job, action, or agent
  parameters?: Record<string, any>;
}

export interface PipelineConfig {
  name: string;
  stages: PipelineStage[];
}

export interface Pipeline {
  id: string;
  config: PipelineConfig;
  status: 'pending' | 'running' | 'completed' | 'errored';
  createdAt: number;
}

export interface AgentConfig {
  name: string;
  queries: string[];
  summaryPrompt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: 'pending' | 'running' | 'completed' | 'errored';
  createdAt: number;
  analysisFile?: string;
}
