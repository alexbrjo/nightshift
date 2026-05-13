export interface InferenceJob {
  id: number;
  job_type: "inference" | "transform" | string;
  name: string;
  prompt_file: string;
  data_source: string;
  provider: string;
  model: string;
  server_url: string;
  output_mode: string;
  temperature?: number;
  max_tokens?: number;
  thinking_budget?: number;
  samples: number;
  strategy: string;
  json_schema_file?: string;
  transform_script_file?: string;
  transform_error_mode?: string;
  transform_output_mode?: string;
  status: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionItem {
  id: number;
  collection_id: number;
  data: Record<string, unknown>;
  created_at: string;
}

export interface Collection {
  id: number;
  job_id: number;
  name: string;
  created_at: string;
}

export interface JobFailure {
  id: number;
  job_id: number;
  sample_index: number;
  error: string;
  created_at: string;
}

export interface MethodWorkflowNode {
  id: string;
  label?: string;
  type: string;
  kind?: string;
  path?: string;
  reference?: string;
  depends_on?: string[];
  config?: Record<string, unknown>;
}

export interface MethodDocument {
  schema_version: number;
  id: string;
  title: string;
  objective: string;
  workflow: {
    nodes: MethodWorkflowNode[];
  };
  parameters: Record<string, unknown>;
  provider: Record<string, unknown>;
  outputs?: string[];
  metadata?: Record<string, unknown>;
}

export interface MethodSummary {
  id: string;
  title: string;
  contentHash: string;
  folderPath: string;
  createdAt: string;
}

export interface MethodPreflightBlocker {
  code: string;
  message: string;
  fileId?: string;
  fileKind?: string;
  path?: string;
}

export interface MethodPreflightResult {
  status: "drafting" | "ready";
  blockers: MethodPreflightBlocker[];
}

export type MethodLifecycleState = "drafting" | "ready" | "executing" | "completed" | "failed";

export interface MethodDraftIssue {
  code: string;
  message: string;
  nodeId?: string;
  resourceId?: string;
}

export interface MethodDraftReadiness {
  status: MethodLifecycleState;
  blockers: MethodDraftIssue[];
  warnings: MethodDraftIssue[];
}

export interface CodexAppServerSession {
  threadId: string;
}

export interface CodexTurnSummary {
  threadId: string;
  turnId: string;
}

export interface DesignAgentConfig {
  model: string;
  reasoningSummary: string;
  maxToolLoops: number;
}

export interface CodexAppServerEvent {
  eventType: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  textDelta?: string;
  messageText?: string;
  traceKind?: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  outputSummary?: string;
  durationMs?: number;
  status?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
}

export interface MethodExecutionSummary {
  id: number;
  methodId: string;
  methodContentHash: string;
  status: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface MethodExecutionNodeSummary {
  id: number;
  executionId: number;
  nodeId: string;
  nodeType: string;
  status: string;
  outputRef?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface MethodExecutionEventSummary {
  id: number;
  executionId: number;
  nodeId?: string;
  eventType: string;
  payloadJson: Record<string, unknown>;
  createdAt: string;
}

export interface MethodArtifactSummary {
  id: number;
  executionId: number;
  nodeId?: string;
  artifactType: string;
  storageKind: string;
  storageRef: string;
  contentHash: string;
  createdAt: string;
}
