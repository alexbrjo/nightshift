export const JobProvider = {
  Local: "Local",
  OpenAI: "OpenAI",
  Anthropic: "Anthropic",
  Google: "Google",
  Custom: "Custom",
} as const;

export type JobProvider = (typeof JobProvider)[keyof typeof JobProvider];

export const JobOutputMode = {
  Unstructured: "Unstructured",
  PlainJson: "Plain JSON",
  JsonSchema: "JSON Schema",
} as const;

export type JobOutputMode = (typeof JobOutputMode)[keyof typeof JobOutputMode];

export const JobStrategy = {
  Single: "Single",
  Random: "Random",
  Exhaustive: "Exhaustive",
} as const;

export type JobStrategy = (typeof JobStrategy)[keyof typeof JobStrategy];

export const ThinkingOption = {
  Off: "Off",
  Low: "Low",
  Medium: "Medium",
  High: "High",
} as const;

export type ThinkingOption = (typeof ThinkingOption)[keyof typeof ThinkingOption];

export const TransformErrorMode = {
  Stop: "stop",
  Skip: "skip",
} as const;

export type TransformErrorMode = (typeof TransformErrorMode)[keyof typeof TransformErrorMode];

export const TransformOutputMode = {
  OneToOne: "one_to_one",
  UnwrapArrays: "unwrap_arrays",
} as const;

export type TransformOutputMode = (typeof TransformOutputMode)[keyof typeof TransformOutputMode];

export interface JobConfig {
  name: string;
  promptFile: string;
  dataSource: string;
  provider: JobProvider;
  model: string;
  serverUrl: string;
  outputMode: JobOutputMode;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  samples: number;
  strategy: JobStrategy;
  jsonSchemaFile?: string;
}

export interface TransformJobConfig {
  name: string;
  dataSource: string;
  scriptFile: string;
  errorMode: TransformErrorMode;
  outputMode: TransformOutputMode;
}

export const PROVIDERS = Object.values(JobProvider);
export const OUTPUT_MODES = Object.values(JobOutputMode);
export const STRATEGIES = Object.values(JobStrategy);
export const THINKING_OPTIONS = Object.values(ThinkingOption);

export const DEFAULT_SERVER_URL = "http://localhost:1234";

export const INITIAL_FORM_STATE: JobConfig = {
  name: "",
  promptFile: "",
  dataSource: "",
  provider: JobProvider.Local,
  model: "bonsai-8b",
  serverUrl: DEFAULT_SERVER_URL,
  outputMode: JobOutputMode.JsonSchema,
  samples: 1,
  strategy: JobStrategy.Single,
};

export const INITIAL_TRANSFORM_STATE: TransformJobConfig = {
  name: "",
  dataSource: "",
  scriptFile: "",
  errorMode: TransformErrorMode.Stop,
  outputMode: TransformOutputMode.OneToOne,
};

export function formatSubmitError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
