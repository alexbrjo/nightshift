import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../setupTests";
import AgentWorkspace from "./AgentWorkspace";

const eventBus = vi.hoisted(() => ({
  handlers: [] as Array<(event: { payload: Record<string, unknown> }) => void>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    eventBus.handlers.push(handler);
    return Promise.resolve(() => {});
  }),
}));

describe("AgentWorkspace", () => {
  beforeEach(() => {
    eventBus.handlers = [];
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "list_methods":
          return Promise.resolve([]);
        case "list_method_executions":
          return Promise.resolve([]);
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "get_method_execution_artifacts":
          return Promise.resolve([]);
        case "preflight_method":
          return Promise.resolve({ status: "ready", blockers: [] });
        case "chat_method_agent":
          return Promise.resolve({
            message: "Drafted the Method with an inference, scoring, aggregation, and analysis workflow.",
            questions: [],
            method: {
              schema_version: 1,
              id: "edge-method",
              title: "Edge model comparison",
              objective: "Compare edge models.",
              files: [
                { id: "prompt", kind: "prompt", path: "flash_cards/main.jinja2" },
                { id: "data", kind: "data", path: "100_Verben.json" },
                { id: "schema", kind: "schema", path: "flash_card.schema.json" },
                { id: "eval_script", kind: "script", path: "flash_cards/score.js" },
              ],
              provider: { provider: "Local", server_url: "http://localhost:1234", model: "bonsai-8b" },
              parameters: { model_values: ["bonsai-8b", "qwen3.5-4b"], samples: 5 },
              workflow: {
                nodes: [
                  { id: "generate", type: "inference", depends_on: [] },
                  { id: "score", type: "transform", depends_on: ["generate"] },
                  { id: "aggregate", type: "aggregate", depends_on: ["score"] },
                  { id: "analysis", type: "analysis", depends_on: ["aggregate"] },
                ],
              },
            },
          });
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("uses chat as the primary Method drafting surface", async () => {
    render(<AgentWorkspace />);

    const input = screen.getByPlaceholderText(/Describe a Method/i);
    fireEvent.change(input, {
      target: {
        value:
          "compare bonsai-8b and qwen3.5-4b with prompt flash_cards/main.jinja2, data 100_Verben.json, schema flash_card.schema.json, eval script flash_cards/score.js",
      },
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("chat_method_agent", {
        input: expect.objectContaining({
          message: expect.stringContaining("compare bonsai-8b"),
        }),
      });
      expect(screen.getByText(/Drafted the Method/i)).toBeInTheDocument();
      expect(screen.getByText("generate")).toBeInTheDocument();
      expect(screen.getByText("score")).toBeInTheDocument();
      expect(screen.getAllByText("aggregate").length).toBeGreaterThan(0);
      expect(screen.getAllByText("analysis").length).toBeGreaterThan(0);
    });
  });

  it("saves a drafted Method from the chat controls", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "list_methods":
          return Promise.resolve([]);
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "get_method_execution_artifacts":
          return Promise.resolve([]);
        case "preflight_method":
          return Promise.resolve({ status: "ready", blockers: [] });
        case "save_method":
          return Promise.resolve({
            id: "edge-method",
            title: "Edge model comparison",
            contentHash: "abc123",
            folderPath: "/tmp/methods/edge-method",
            createdAt: "2026-05-07",
          });
        default:
          return Promise.resolve([]);
      }
    });

    render(<AgentWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("save_method", {
        input: { method: expect.objectContaining({ id: "edge-method" }) },
      });
      expect(screen.getByText(/Saved Method “Edge model comparison”/i)).toBeInTheDocument();
    });
  });

  it("asks for missing Method files instead of saving", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "list_methods":
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "get_method_execution_artifacts":
          return Promise.resolve([]);
        case "preflight_method":
          return Promise.resolve({
            status: "drafting",
            blockers: [
              {
                code: "missing_file",
                message: "Inference needs a prompt template",
                fileKind: "prompt",
              },
            ],
          });
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalledWith("save_method", expect.anything());
      expect(screen.getByText(/Which prompt file should I use/i)).toBeInTheDocument();
    });
  });

  it("streams created inference jobs into chat", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "list_methods":
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "get_method_execution_artifacts":
          return Promise.resolve([]);
        case "preflight_method":
          return Promise.resolve({ status: "ready", blockers: [] });
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    eventBus.handlers.forEach((handler) =>
      handler({
        payload: {
          executionId: 1,
          nodeId: "generate",
          eventType: "inference_job_created",
          payload: { jobId: 12, model: "bonsai-8b", samples: 5 },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Created inference job #12 for bonsai-8b/i)).toBeInTheDocument();
    });
  });

  it("loads execution artifacts into the visualization panel", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "list_methods":
          return Promise.resolve([
            {
              id: "edge-method",
              title: "Edge model comparison",
              contentHash: "abc123",
              folderPath: "/tmp/methods/edge-method",
              createdAt: "2026-05-07",
            },
          ]);
        case "get_method":
          return Promise.resolve({
            schema_version: 1,
            id: "edge-method",
            title: "Edge model comparison",
            workflow: { nodes: [{ id: "analysis", type: "analysis", depends_on: [] }] },
            provider: { model: "bonsai-8b" },
            parameters: {},
            files: [],
          });
        case "list_method_executions":
          return Promise.resolve([
            {
              id: 7,
              methodId: "edge-method",
              methodContentHash: "abc123",
              status: "completed",
              createdAt: "2026-05-07",
            },
          ]);
        case "get_method_execution_nodes":
          return Promise.resolve([
            {
              id: 1,
              executionId: 7,
              nodeId: "analysis",
              nodeType: "analysis",
              status: "completed",
            },
          ]);
        case "get_method_execution_events":
          return Promise.resolve([]);
        case "get_method_execution_artifacts":
          return Promise.resolve([
            {
              id: 3,
              executionId: 7,
              nodeId: "analysis",
              artifactType: "analysis",
              storageKind: "inline_markdown",
              storageRef: "# Analysis",
              contentHash: "hash",
              createdAt: "2026-05-07",
            },
          ]);
        case "read_method_artifact":
          return Promise.resolve("# Analysis\nsuccess_rate: 0.9");
        default:
          return Promise.resolve([]);
      }
    });

    render(<AgentWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /Edge model comparison/i }));

    await waitFor(() => {
      expect(screen.getByText("Results")).toBeInTheDocument();
      expect(screen.getByText(/success_rate: 0.9/)).toBeInTheDocument();
    });
  });
});
