import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MethodDocument } from "../database";
import MethodGraph, { buildMethodGraphElements, fitMethodGraphViewport } from "./MethodGraph";

function methodDraft(overrides: Partial<MethodDocument> = {}): MethodDocument {
  return {
    schema_version: 1,
    id: "draft-graph",
    title: "Graph draft",
    objective: "Render a Method graph",
    resources: [],
    workflow: { nodes: [] },
    parameters: {},
    provider: {},
    outputs: [],
    metadata: {},
    ...overrides,
  };
}

describe("buildMethodGraphElements", () => {
  it("maps Method draft nodes and edges into React Flow elements", () => {
    const draft = methodDraft({
      resources: [
        {
          id: "prompt",
          kind: "prompt",
          label: "Prompt",
          consumed_by: ["generate"],
        },
        {
          id: "schema",
          kind: "json_schema",
          label: "Output schema",
          path: "schemas/out.json",
          consumed_by: ["score"],
        },
      ],
      workflow: {
        nodes: [
          {
            id: "generate",
            label: "Generate answers",
            type: "inference",
            config: { model: "gpt-test", samples: 4 },
          },
          {
            id: "score",
            label: "Score answers",
            type: "eval",
            depends_on: ["generate"],
            config: {},
          },
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
        data: { resources: [expect.objectContaining({ id: "prompt" })] },
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
        label: undefined,
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
          issues: [expect.objectContaining({ message: "Attach prompt for 'Prompt'." })],
          configHints: ["model: gpt-test", "samples: 4"],
        }),
      }),
    );
    expect(methodNodes[1].position.x).toBe(methodNodes[0].position.x);
    expect(methodNodes[1].position.y).toBeGreaterThan(methodNodes[0].position.y);
    expect(methodNodes[1].data.incomingLabels).toEqual(["Generate answers"]);
    expect(methodNodes[1].data.warningCount).toBe(0);
    expect(methodNodes[1].data.issues).toEqual([]);
  });

  it("groups resources with identical consumers into one input bundle", () => {
    const draft = methodDraft({
      resources: [
        { id: "data", kind: "data", label: "Dataset", path: "data.jsonl", consumed_by: ["a", "b"] },
        { id: "prompt", kind: "prompt", label: "Prompt", path: "prompt.md", consumed_by: ["b", "a"] },
        { id: "script", kind: "eval_script", label: "Script", path: "eval.js", consumed_by: ["eval"] },
      ],
      workflow: {
        nodes: [
          { id: "a", label: "Model A", type: "inference", config: {} },
          { id: "b", label: "Model B", type: "inference", config: {} },
          { id: "eval", label: "Evaluate", type: "eval", depends_on: ["a", "b"], config: {} },
        ],
      },
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
      workflow: {
        nodes: [
          { id: "a", label: "A", type: "analysis", depends_on: ["b", "missing"], config: {} },
          { id: "b", label: "B", type: "aggregate", depends_on: ["a"], config: {} },
        ],
      },
    });

    const graph = buildMethodGraphElements(draft);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((node) => node.position.x)).toEqual([0, 0]);
    expect(graph.nodes[1].position.y).toBeGreaterThan(graph.nodes[0].position.y);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["b-a", "missing-a", "a-b"]);
  });

  it("shows inherited execution config on inference nodes without node-level config", () => {
    const draft = methodDraft({
      workflow: {
        nodes: [
          { id: "generate", label: "Generate", type: "inference", config: undefined },
          { id: "score", label: "Score", type: "eval", config: undefined },
        ],
      },
      parameters: {
        model_values: ["bonsai-8b", "qwen3.5-4b"],
        samples: 5,
        max_tokens: 2000,
      },
      provider: {
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

  it("shows inherited sampling config on sample nodes without node-level config", () => {
    const draft = methodDraft({
      workflow: {
        nodes: [{ id: "sample_records", label: "Sample records", type: "sample", config: undefined }],
      },
      parameters: {
        samples: 3,
        strategy: "random",
      },
    });

    const graph = buildMethodGraphElements(draft);

    expect(graph.nodes[0].data.configHints).toEqual(["samples: 3", "strategy: random"]);
  });

  it("fits graph bounds inside narrow panes without clipping the right edge", () => {
    const draft = methodDraft({
      resources: [
        { id: "data", kind: "data", label: "Dataset", path: "data.jsonl", consumed_by: ["sample"] },
        { id: "prompt", kind: "prompt", label: "Prompt", path: "prompt.md", consumed_by: ["generate"] },
      ],
      workflow: {
        nodes: [
          { id: "sample", label: "Sample records", type: "sample", config: {} },
          { id: "generate", label: "Generate cards", type: "inference", depends_on: ["sample"], config: {} },
          { id: "judge", label: "Judge cards", type: "inference", depends_on: ["generate"], config: {} },
        ],
      },
    });

    const graph = buildMethodGraphElements(draft);
    const viewport = fitMethodGraphViewport(graph.nodes, { width: 360, height: 640 });

    const rightEdge = Math.max(
      ...graph.nodes.map((node) => node.position.x + (node.type === "resource" ? 260 : 300)),
    );
    const leftEdge = Math.min(...graph.nodes.map((node) => node.position.x));

    expect(leftEdge * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0);
    expect(rightEdge * viewport.zoom + viewport.x).toBeLessThanOrEqual(360);
    expect(viewport.zoom).toBeLessThan(1);
  });

  it("renders richer visual status badges for execution nodes", () => {
    const draft = methodDraft({
      workflow: {
        nodes: [
          { id: "done", label: "Done", type: "sample", config: {} },
          { id: "run", label: "Run", type: "inference", depends_on: ["done"], config: {} },
          { id: "wait", label: "Wait", type: "eval", depends_on: ["run"], config: {} },
          { id: "bad", label: "Bad", type: "analysis", depends_on: ["wait"], config: {} },
        ],
      },
    });

    render(
      <MethodGraph
        draft={draft}
        executionNodes={[
          { id: 1, executionId: 1, nodeId: "done", nodeType: "sample", status: "completed" },
          { id: 2, executionId: 1, nodeId: "run", nodeType: "inference", status: "running" },
          { id: 3, executionId: 1, nodeId: "wait", nodeType: "eval", status: "queued" },
          { id: 4, executionId: 1, nodeId: "bad", nodeType: "analysis", status: "failed" },
        ]}
      />,
    );

    const runningStatus = screen.getByText("Running").closest(".method-flow-status");
    expect(runningStatus).toHaveClass("status-running");
    expect(runningStatus?.lastElementChild).toHaveClass("method-flow-recording-dot");
    expect(document.querySelector(".method-flow-recording-dot")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("×")).toBeInTheDocument();
    expect(screen.getByText("Queued").closest(".method-flow-node")).toHaveClass("status-queued");
    expect(screen.getByText("inference").closest(".method-flow-node-header")).toBeInTheDocument();
    expect(screen.getByText("Run")).toHaveClass("method-flow-node-description");
  });
});
