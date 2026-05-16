import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MethodDocument } from "../../database";
import MethodGraph, { buildMethodGraphElements, fitMethodGraphViewport } from "./MethodGraph";

function methodDraft(overrides: Partial<MethodDocument> = {}): MethodDocument {
  return {
    schema_version: 1,
    id: "draft-graph",
    title: "Graph draft",
    objective: "Render a Method graph",
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
      workflow: {
        nodes: [
          {
            id: "prompt",
            label: "Prompt",
            type: "resource",
            kind: "prompt",
          },
          {
            id: "schema",
            label: "Output schema",
            type: "resource",
            kind: "json_schema",
            path: "schemas/out.json",
          },
          {
            id: "generate",
            label: "Generate answers",
            type: "inference",
            depends_on: ["prompt"],
            config: { model: "gpt-test", samples: 4 },
          },
          {
            id: "score",
            label: "Score answers",
            type: "transform",
            depends_on: ["generate", "schema"],
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
        id: "prompt",
        type: "resource",
        position: { x: -416, y: 0 },
        data: { resource: expect.objectContaining({ id: "prompt" }) },
      }),
      expect.objectContaining({
        id: "schema",
        type: "resource",
        data: { resource: expect.objectContaining({ id: "schema", path: "schemas/out.json" }) },
      }),
    ]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "prompt-generate",
        source: "prompt",
        target: "generate",
        sourceHandle: "right",
        targetHandle: "left",
      }),
      expect.objectContaining({
        id: "schema-score",
        source: "schema",
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

  it("uses uniform resource nodes at method width and half method height", () => {
    const draft = methodDraft({
      workflow: {
        nodes: [
          {
            id: "long_prompt",
            label: "Flash-card generation prompt template",
            type: "resource",
            kind: "prompt",
            path: "flash_cards/flash_card_prompt_template.jinja2",
          },
          {
            id: "generate",
            label: "Generate cards",
            type: "inference",
            depends_on: ["long_prompt"],
            config: {},
          },
        ],
      },
    });

    const graph = buildMethodGraphElements(draft);
    const resource = graph.nodes.find((node) => node.id === "long_prompt");

    expect(resource?.type).toBe("resource");
    expect(resource?.style).toBeUndefined();
    expect(resource?.position.x).toBe(-416);
  });

  it("renders shared resource nodes as first-class inputs", () => {
    const draft = methodDraft({
      workflow: {
        nodes: [
          { id: "data", label: "Dataset", type: "resource", kind: "data", path: "data.jsonl" },
          { id: "prompt", label: "Prompt", type: "resource", kind: "prompt", path: "prompt.md" },
          { id: "script", label: "Script", type: "resource", kind: "script", path: "transform.js" },
          { id: "a", label: "Model A", type: "inference", depends_on: ["data", "prompt"], config: {} },
          { id: "b", label: "Model B", type: "inference", depends_on: ["data", "prompt"], config: {} },
          { id: "transform", label: "Transform", type: "transform", depends_on: ["a", "b", "script"], config: {} },
        ],
      },
    });

    const graph = buildMethodGraphElements(draft);
    const resourceNodes = graph.nodes.filter((node) => node.type === "resource");

    expect(resourceNodes).toHaveLength(3);
    expect(resourceNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "data" }),
      expect.objectContaining({ id: "prompt" }),
      expect.objectContaining({ id: "script" }),
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "data-a", source: "data", target: "a" }),
      expect.objectContaining({ id: "prompt-b", source: "prompt", target: "b" }),
      expect.objectContaining({ id: "script-transform", source: "script", target: "transform" }),
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
          { id: "score", label: "Score", type: "transform", config: undefined },
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
      workflow: {
        nodes: [
          { id: "data", kind: "data", label: "Dataset", type: "resource", path: "data.jsonl" },
          { id: "prompt", kind: "prompt", label: "Prompt", type: "resource", path: "prompt.md" },
          { id: "sample", label: "Sample records", type: "sample", depends_on: ["data"], config: {} },
          { id: "generate", label: "Generate cards", type: "inference", depends_on: ["sample", "prompt"], config: {} },
          { id: "judge", label: "Judge cards", type: "inference", depends_on: ["generate"], config: {} },
        ],
      },
    });

    const graph = buildMethodGraphElements(draft);
    const viewport = fitMethodGraphViewport(graph.nodes, { width: 360, height: 640 });

    const rightEdge = Math.max(
      ...graph.nodes.map((node) => {
        const width = node.type === "resource"
          ? 300
          : 300;
        return node.position.x + width;
      }),
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
          { id: "wait", label: "Wait", type: "transform", depends_on: ["run"], config: {} },
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
          { id: 3, executionId: 1, nodeId: "wait", nodeType: "transform", status: "queued" },
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
