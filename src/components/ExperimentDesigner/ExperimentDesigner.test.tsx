// Integration test for the planner loop:
//   1. Start planning → file lists fetched, first chat_complete call made.
//   2. Agent emits a "question" → user picks an option → next chat_complete
//      receives the prior assistant + new user message in history.
//   3. Agent emits "experiment" → ProposalCard appears → Save invokes
//      save_experiment with the proposed object.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { mockInvoke } from "../../setupTests";
import ExperimentDesigner from "./ExperimentDesigner";
import type { Experiment } from "../../utils/experimentSchema";

const sampleExperiment: Experiment = {
  schema_version: 1,
  id: "demo",
  hypothesis: "Bigger wins",
  created_at: "2026-05-05T00:00:00Z",
  independent_variable: { name: "model", values: ["a", "b"] },
  controlled_variables: {
    provider: "Local",
    model: "test-model",
    server_url: "http://localhost:8080",
    prompt_file: "prompts/main.jinja2",
    data_source: "data/inputs.jsonl",
    output_mode: "Unstructured",
    samples: 5,
    strategy: "exhaustive",
  },
  trial_template: {
    nodes: [{ type: "inference", id: "generate", depends_on: [] }],
  },
  evals: [],
  aggregate: { group_by: ["independent_variable"], metrics: [] },
  analysis_agent: {
    provider: "Local",
    model: "test-model",
    system_prompt_file: "prompts/main.jinja2",
    output_file: "analysis.md",
  },
};

describe("ExperimentDesigner integration", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    // jsdom 29 + node 22 has a flaky localStorage shim; provide our own.
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size;
        },
      },
    });
    localStorage.setItem(
      "nightshift-planner-settings",
      JSON.stringify({ provider: "Local", model: "test-model", server_url: "http://x" }),
    );
  });

  it("walks through one Q&A turn then saves an emitted experiment", async () => {
    // Sequence of chat_complete responses the agent will emit.
    const turns: string[] = [
      JSON.stringify({
        kind: "question",
        header: "IV",
        question: "Which variable?",
        options: [{ label: "model" }, { label: "temperature" }],
        multiSelect: false,
        allowOther: false,
      }),
      JSON.stringify({ kind: "experiment", experiment: sampleExperiment }),
    ];

    mockInvoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "list_experiments":
          return [];
        case "list_prompt_files":
          return ["prompts/main.jinja2"];
        case "list_data_files":
          return ["data/inputs.jsonl"];
        case "list_schema_files":
          return [];
        case "list_transform_scripts":
          return [];
        case "chat_complete": {
          const content = turns.shift();
          return { content, reasoning: null, raw_body: content };
        }
        case "save_experiment":
          return { id: "demo", hypothesis: "Bigger wins", created_at: "x", independent_variable_name: "model", bundle_path: "/x" };
        default:
          throw new Error(`unexpected command: ${cmd}`);
      }
    });

    render(<ExperimentDesigner />);

    fireEvent.click(screen.getByRole("button", { name: /start planning/i }));

    // First turn renders. Several async steps — file lists, context, then
    // chat_complete — so allow more than vitest's 1-second default.
    await waitFor(
      () => {
        const calls = mockInvoke.mock.calls.filter((c: unknown[]) => c[0] === "chat_complete");
        if (calls.length === 0) throw new Error("chat_complete not yet called");
      },
      { timeout: 4000 },
    );
    // The question text now appears in multiple places (QuestionCard +
    // debug-panel conversation/raw-response dumps), so use getAllByText.
    await waitFor(
      () => {
        const matches = screen.getAllByText(/Which variable\?/);
        if (matches.length === 0) throw new Error("not yet");
      },
      { timeout: 4000 },
    );
    fireEvent.click(screen.getByLabelText(/^model$/));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    // Proposal card appears after the agent emits "experiment".
    await waitFor(() => screen.getByRole("button", { name: /save bundle/i }));
    fireEvent.click(screen.getByRole("button", { name: /save bundle/i }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "save_experiment",
        expect.objectContaining({
          experiment: expect.objectContaining({ id: "demo", schema_version: 1 }),
        }),
      ),
    );

    // chat_complete was called twice (initial + after user answer); verify
    // the second call carried the prior assistant + the user's answer.
    const chatCalls = mockInvoke.mock.calls.filter((c: unknown[]) => c[0] === "chat_complete");
    expect(chatCalls).toHaveLength(2);
    const secondMessages = chatCalls[1][1].messages;
    expect(secondMessages.at(-2).role).toBe("assistant");
    expect(secondMessages.at(-1)).toMatchObject({ role: "user", content: "model" });
  });
});
