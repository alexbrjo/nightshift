// Single source of truth for the experiment-definition shape on the renderer
// side. Mirrors `Experiment` and friends in src-tauri/src/commands/experiments.rs.
//
// The same JSON Schema (PLANNER_TURN_SCHEMA) is also passed to the LLM as
// `response_format` so the planner agent can only emit one of three shapes:
// a multiple-choice question, a freeform-input request, or a final
// experiment definition.

export type IvName =
  | "model"
  | "temperature"
  | "prompt_file"
  | "max_tokens"
  | "system_prompt";

export const ALLOWED_IV_NAMES: IvName[] = [
  "model",
  "temperature",
  "prompt_file",
  "max_tokens",
  "system_prompt",
];

export type OutputMode = "Unstructured" | "Plain JSON" | "JSON Schema";
export type SamplingStrategy = "single" | "random" | "exhaustive";
export type ErrorMode = "stop" | "skip";
export type TransformOutputMode = "one_to_one" | "unwrap_arrays";
export type Aggregation = "mean" | "sum" | "count" | "p50" | "p95";

export interface IndependentVariable {
  name: IvName;
  values: (string | number | boolean)[];
}

export interface ControlledVariables {
  provider: string;
  /** Optional when `independent_variable.name === "model"` (the IV sweeps
   *  over models so a fixed default would be contradictory). Required
   *  otherwise. Same rule for `prompt_file`. */
  model?: string;
  server_url: string;
  prompt_file?: string;
  data_source: string;
  output_mode: OutputMode;
  json_schema_file?: string;
  temperature?: number;
  max_tokens?: number;
  thinking_budget?: number;
  samples: number;
  strategy: SamplingStrategy;
}

export type TrialNode =
  | {
      type: "inference";
      id: string;
      role?: "eval" | string;
      prompt_file?: string;
      provider?: string;
      model?: string;
      output_mode?: OutputMode;
      json_schema_file?: string;
      depends_on?: string[];
    }
  | {
      type: "transform";
      id: string;
      role?: "eval" | string;
      script_file: string;
      error_mode?: ErrorMode;
      output_mode?: TransformOutputMode;
      depends_on?: string[];
    };

export interface TrialTemplate {
  nodes: TrialNode[];
}

export interface EvalMetric {
  name: string;
  source: string;
  field: string;
  agg: Aggregation;
}

export interface Aggregate {
  group_by: string[];
  metrics: string[];
}

export interface AnalysisAgent {
  provider: string;
  model: string;
  system_prompt_file: string;
  output_file: string;
}

export interface Experiment {
  schema_version: 1;
  id: string;
  /** Free-form goal — may be a testable hypothesis or just a benchmark
   *  description ("compare X to Y on task Z"). Empty allowed. */
  hypothesis: string;
  created_at: string;
  independent_variable: IndependentVariable;
  controlled_variables: ControlledVariables;
  trial_template: TrialTemplate;
  evals: EvalMetric[];
  aggregate: Aggregate;
  analysis_agent: AnalysisAgent;
}

export interface ExperimentSummary {
  id: string;
  hypothesis: string;
  created_at: string;
  independent_variable_name: string;
  bundle_path: string;
}

// ---------- Planner-turn schema ----------

export type PlannerOption = { label: string; description?: string };

export type PlannerTurn =
  | {
      kind: "question";
      header: string;
      /** Optional: 1–3 sentence reaction to the user's previous answer
       *  ("good — but I'd push back on X", "you also said Y above so I'll
       *  reuse that"). Rendered in italic above the question so the dialog
       *  feels conversational rather than form-fillout. */
      acknowledgment?: string;
      question: string;
      options: PlannerOption[];
      multiSelect: boolean;
      allowOther: boolean;
    }
  | {
      kind: "freeform";
      header: string;
      acknowledgment?: string;
      prompt: string;
      placeholder?: string;
    }
  | {
      kind: "experiment";
      acknowledgment?: string;
      experiment: Experiment;
    };

// JSON Schema passed as `response_format.json_schema.schema` to the LLM each
// turn. We don't ship a complete schema for `experiment` (the LLM gets the
// shape from the system prompt and validation happens server-side); this
// keeps the schema small enough that local models honor it reliably.
export const PLANNER_TURN_SCHEMA = {
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "question" },
        header: { type: "string" },
        acknowledgment: { type: "string" },
        question: { type: "string" },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label"],
          },
        },
        multiSelect: { type: "boolean" },
        allowOther: { type: "boolean" },
      },
      required: ["kind", "header", "question", "options", "multiSelect", "allowOther"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "freeform" },
        header: { type: "string" },
        acknowledgment: { type: "string" },
        prompt: { type: "string" },
        placeholder: { type: "string" },
      },
      required: ["kind", "header", "prompt"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "experiment" },
        acknowledgment: { type: "string" },
        experiment: { type: "object" },
      },
      required: ["kind", "experiment"],
    },
  ],
} as const;

// Loose runtime guard. The LLM occasionally wraps its JSON in a code fence;
// accept that, then validate the discriminator field.
export function parsePlannerTurn(content: string): PlannerTurn {
  const stripped = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new Error(`Planner did not return valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Planner output is not an object");
  }
  const kind = (parsed as { kind?: string }).kind;
  if (kind !== "question" && kind !== "freeform" && kind !== "experiment") {
    throw new Error(`Planner output has unknown kind: ${String(kind)}`);
  }
  return parsed as PlannerTurn;
}
