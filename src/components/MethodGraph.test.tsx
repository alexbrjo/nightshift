import { describe, expect, it } from "vitest";
import type { MethodDraft } from "../database";
import { buildMethodGraphElements } from "./MethodGraph";

function methodDraft(overrides: Partial<MethodDraft> = {}): MethodDraft {
  return {
    schemaVersion: 1,
    id: "draft-graph",
    title: "Graph draft",
    objective: "Render a Method graph",
    lifecycle: "drafting",
    resources: [],
    nodes: [],
    edges: [],
    parameters: {},
    providerConfig: {},
    outputs: [],
    metadata: {},
    readiness: { status: "drafting", blockers: [], warnings: [] },
    ...overrides,
  };
}

describe("buildMethodGraphElements", () => {
  it("maps Method draft nodes and edges into React Flow elements", () => {
    const draft = methodDraft({
      resources: [
        {
          id: "prompt",
          kind: "prompt_file",
          label: "Prompt",
          status: "missing",
          path: "prompts/main.md",
          consumedBy: ["generate"],
        },
        {
          id: "schema",
          kind: "json_schema",
          label: "Output schema",
          status: "attached",
          path: "schemas/out.json",
          consumedBy: ["score"],
        },
      ],
      nodes: [
        {
          id: "generate",
          label: "Generate answers",
          type: "inference",
          status: "draft",
          config: { model: "gpt-test", samples: 4 },
        },
        {
          id: "score",
          label: "Score answers",
          type: "eval",
          status: "draft",
          config: {},
        },
      ],
      edges: [{ from: "generate", to: "score" }],
      readiness: {
        status: "drafting",
        blockers: [{ code: "missing_prompt", message: "Attach a prompt.", nodeId: "generate" }],
        warnings: [
          { code: "weak_eval", message: "Eval needs detail.", nodeId: "score" },
          { code: "schema_note", message: "Schema is still loose.", resourceId: "schema" },
        ],
      },
    });

    const graph = buildMethodGraphElements(draft);
    const methodNodes = graph.nodes.filter((node) => node.type === "method");
    const resourceNodes = graph.nodes.filter((node) => node.type === "resource");

    expect(methodNodes).toHaveLength(2);
    expect(resourceNodes).toEqual([
      expect.objectContaining({
        id: "resource:prompt",
        type: "resource",
        position: { x: -340, y: 0 },
        data: { resources: [expect.objectContaining({ id: "prompt", path: "prompts/main.md" })] },
      }),
      expect.objectContaining({
        id: "resource:schema",
        type: "resource",
        data: { resources: [expect.objectContaining({ id: "schema", path: "schemas/out.json" })] },
      }),
    ]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "resource:prompt-generate",
        source: "resource:prompt",
        target: "generate",
        sourceHandle: "right",
        targetHandle: "left",
      }),
      expect.objectContaining({
        id: "resource:schema-score",
        source: "resource:schema",
        target: "score",
        sourceHandle: "right",
        targetHandle: "left",
      }),
      expect.objectContaining({
        id: "generate-score",
        source: "generate",
        target: "score",
        type: "smoothstep",
        label: "2 issues",
      }),
    ]));
    expect(methodNodes[0]).toEqual(
      expect.objectContaining({
        id: "generate",
        type: "method",
        position: { x: 0, y: 0 },
        data: expect.objectContaining({
          blockerCount: 1,
          warningCount: 0,
          resourceCount: 1,
          issues: [expect.objectContaining({ message: "Attach a prompt." })],
          configHints: ["model: gpt-test", "samples: 4"],
        }),
      }),
    );
    expect(methodNodes[1].position.x).toBe(methodNodes[0].position.x);
    expect(methodNodes[1].position.y).toBeGreaterThan(methodNodes[0].position.y);
    expect(methodNodes[1].data.incomingLabels).toEqual(["Generate answers"]);
    expect(methodNodes[1].data.warningCount).toBe(2);
    expect(methodNodes[1].data.issues.map((issue) => issue.message)).toEqual([
      "Eval needs detail.",
      "Schema is still loose.",
    ]);
  });

  it("groups resources with identical consumers into one input bundle", () => {
    const draft = methodDraft({
      resources: [
        { id: "data", kind: "data", label: "Dataset", status: "attached", path: "data.jsonl", consumedBy: ["a", "b"] },
        { id: "prompt", kind: "prompt", label: "Prompt", status: "attached", path: "prompt.md", consumedBy: ["b", "a"] },
        { id: "script", kind: "eval_script", label: "Script", status: "attached", path: "eval.js", consumedBy: ["eval"] },
      ],
      nodes: [
        { id: "a", label: "Model A", type: "inference", status: "draft", config: {} },
        { id: "b", label: "Model B", type: "inference", status: "draft", config: {} },
        { id: "eval", label: "Evaluate", type: "eval", status: "draft", config: {} },
      ],
      edges: [
        { from: "a", to: "eval" },
        { from: "b", to: "eval" },
      ],
    });

    const graph = buildMethodGraphElements(draft);
    const resourceNodes = graph.nodes.filter((node) => node.type === "resource");

    expect(resourceNodes).toHaveLength(2);
    expect(resourceNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "resource:data+prompt",
        data: { resources: [
          expect.objectContaining({ id: "data" }),
          expect.objectContaining({ id: "prompt" }),
        ] },
      }),
      expect.objectContaining({
        id: "resource:script",
      }),
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "resource:data+prompt-a", source: "resource:data+prompt", target: "a" }),
      expect.objectContaining({ id: "resource:data+prompt-b", source: "resource:data+prompt", target: "b" }),
      expect.objectContaining({ id: "resource:script-eval", source: "resource:script", target: "eval" }),
    ]));
  });

  it("keeps cyclic or incomplete drafts renderable", () => {
    const draft = methodDraft({
      nodes: [
        { id: "a", label: "A", type: "analysis", status: "draft", config: {} },
        { id: "b", label: "B", type: "aggregate", status: "draft", config: {} },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "missing", to: "a" },
      ],
    });

    const graph = buildMethodGraphElements(draft);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((node) => node.position.x)).toEqual([0, 0]);
    expect(graph.nodes[1].position.y).toBeGreaterThan(graph.nodes[0].position.y);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["a-b", "b-a", "missing-a"]);
  });

  it("shows inherited execution config on inference nodes without node-level config", () => {
    const draft = methodDraft({
      nodes: [
        { id: "generate", label: "Generate", type: "inference", status: "ready", config: undefined },
        { id: "score", label: "Score", type: "eval", status: "ready", config: undefined },
      ],
      parameters: {
        model_values: ["bonsai-8b", "qwen3.5-4b"],
        samples: 5,
        max_tokens: 2000,
      },
      providerConfig: {
        provider: "Local",
        server_url: "http://localhost:1234/v1",
      },
    });

    const graph = buildMethodGraphElements(draft);
    const methodNodes = graph.nodes.filter((node) => node.type === "method");

    expect(methodNodes[0].data.configHints).toEqual([
      "provider: Local",
      "server_url: http://localhost:1234/v1",
      "model_values: 2 items",
    ]);
    expect(methodNodes[1].data.configHints).toEqual([]);
  });
});
