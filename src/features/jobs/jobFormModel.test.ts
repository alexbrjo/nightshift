import { describe, expect, it } from "vitest";
import {
  INITIAL_FORM_STATE,
  INITIAL_TRANSFORM_STATE,
  JobOutputMode,
  JobProvider,
  JobStrategy,
  OUTPUT_MODES,
  PROVIDERS,
  STRATEGIES,
  THINKING_OPTIONS,
  ThinkingOption,
  TransformErrorMode,
  TransformOutputMode,
} from "./jobFormModel";

describe("jobFormModel constants", () => {
  it("keeps inference option arrays derived from named values", () => {
    expect(PROVIDERS).toEqual([
      JobProvider.Local,
      JobProvider.OpenAI,
      JobProvider.Anthropic,
      JobProvider.Google,
      JobProvider.Custom,
    ]);
    expect(OUTPUT_MODES).toEqual([
      JobOutputMode.Unstructured,
      JobOutputMode.PlainJson,
      JobOutputMode.JsonSchema,
    ]);
    expect(STRATEGIES).toEqual([
      JobStrategy.Single,
      JobStrategy.Random,
      JobStrategy.Exhaustive,
    ]);
    expect(THINKING_OPTIONS).toEqual([
      ThinkingOption.Off,
      ThinkingOption.Low,
      ThinkingOption.Medium,
      ThinkingOption.High,
    ]);
  });

  it("uses named values for default form state", () => {
    expect(INITIAL_FORM_STATE.provider).toBe(JobProvider.Local);
    expect(INITIAL_FORM_STATE.outputMode).toBe(JobOutputMode.JsonSchema);
    expect(INITIAL_FORM_STATE.strategy).toBe(JobStrategy.Single);
    expect(INITIAL_TRANSFORM_STATE.errorMode).toBe(TransformErrorMode.Stop);
    expect(INITIAL_TRANSFORM_STATE.outputMode).toBe(TransformOutputMode.OneToOne);
  });
});
