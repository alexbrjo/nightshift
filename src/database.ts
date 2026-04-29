export interface InferenceJob {
  id: number;
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
  pre_render_url?: string;
  pre_render_timeout?: number;
  pre_render_body?: string;
  json_schema_file?: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionItem {
  id: number;
  collection_id: number;
  data: Record<string, unknown>;
  created_at: string;
}
