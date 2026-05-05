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

// Orchestrator types — definition / version / execution model.
// Field names are camelCase from the Rust side (`#[serde(rename_all = "camelCase")]`).

export type DefinitionKind = "group" | "inference" | "analysis" | "js_action";
export type GroupMode = "sequential" | "parallel";

export interface JobDefinition {
  id: number;
  parentId: number | null;
  rootId: number;
  name: string;
  position: number;
  currentVersionId: number | null;
  source: "user" | "synthesized" | string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobDefinitionVersion {
  id: number;
  definitionId: number;
  parentVersionId: number | null;
  contentHash: string;
  kind: DefinitionKind;
  mode: GroupMode | null;
  /** Stored as JSON-stringified text on the backend; clients parse on read. */
  params: string;
  /** JSON-stringified text or null. */
  inputRef: string | null;
  description: string | null;
  message: string | null;
  createdBy: string;
  triggeredByExecutionId: number | null;
  createdAt: string;
}

export interface DefinitionContentInput {
  kind: DefinitionKind;
  mode?: GroupMode | null;
  params: Record<string, unknown>;
  inputRef?: Record<string, unknown> | null;
  description?: string | null;
  message?: string | null;
}

export interface DefinitionWithVersion {
  definition: JobDefinition;
  version: JobDefinitionVersion | null;
}

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobExecution {
  id: number;
  definitionVersionId: number;
  parentId: number | null;
  rootId: number;
  status: ExecutionStatus;
  /** JSON-stringified plan (root only). */
  plan: string | null;
  /** JSON-stringified ledger (root planner state or analysis-leaf steps). */
  ledger: string | null;
  cancellationRequested: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
}

export type ExecutionItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface ExecutionCollectionItem {
  id: number;
  collectionId: number;
  itemIndex: number;
  status: ExecutionItemStatus;
  attempt: number;
  /** JSON-stringified output object or null until completed. */
  data: string | null;
  error: string | null;
  backend: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  latencyMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
