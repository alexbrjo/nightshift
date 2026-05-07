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
          consumedBy: ["generate"],
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
        warnings: [{ code: "weak_eval", message: "Eval needs detail.", nodeId: "score" }],
      },
    });

    const graph = buildMethodGraphElements(draft);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        id: "generate-score",
        source: "generate",
        target: "score",
        type: "smoothstep",
      }),
    ]);
    expect(graph.nodes[0]).toEqual(
      expect.objectContaining({
        id: "generate",
        type: "method",
        position: { x: 0, y: 0 },
        data: expect.objectContaining({
          blockerCount: 1,
          warningCount: 0,
          resourceCount: 1,
          configHints: ["model: gpt-test", "samples: 4"],
        }),
      }),
    );
    expect(graph.nodes[1].position.x).toBe(graph.nodes[0].position.x);
    expect(graph.nodes[1].position.y).toBeGreaterThan(graph.nodes[0].position.y);
    expect(graph.nodes[1].data.incomingLabels).toEqual(["Generate answers"]);
    expect(graph.nodes[1].data.warningCount).toBe(1);
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
});
