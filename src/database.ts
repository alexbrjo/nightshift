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
