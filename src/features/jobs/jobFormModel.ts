export interface JobConfig {
  name: string;
  promptFile: string;
  dataSource: string;
  provider: string;
  model: string;
  serverUrl: string;
  outputMode: string;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  samples: number;
  strategy: string;
  jsonSchemaFile?: string;
}

export interface TransformJobConfig {
  name: string;
  dataSource: string;
  scriptFile: string;
  errorMode: "stop" | "skip";
  outputMode: "one_to_one" | "unwrap_arrays";
}

export const PROVIDERS = ["Local", "OpenAI", "Anthropic", "Google", "Custom"];
export const OUTPUT_MODES = ["Unstructured", "Plain JSON", "JSON Schema"];
export const STRATEGIES = ["Single", "Random", "Exhaustive"];
export const THINKING_OPTIONS = ["Off", "Low", "Medium", "High"];

export const DEFAULT_SERVER_URL = "http://localhost:1234";

export const INITIAL_FORM_STATE: JobConfig = {
  name: "",
  promptFile: "",
  dataSource: "",
  provider: "Local",
  model: "bonsai-8b",
  serverUrl: DEFAULT_SERVER_URL,
  outputMode: "JSON Schema",
  samples: 1,
  strategy: "Single",
};

export const INITIAL_TRANSFORM_STATE: TransformJobConfig = {
  name: "",
  dataSource: "",
  scriptFile: "",
  errorMode: "stop",
  outputMode: "one_to_one",
};

export function formatSubmitError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
