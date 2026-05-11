import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../setupTests";
import AgentWorkspace from "./AgentWorkspace";

const eventBus = vi.hoisted(() => ({
  handlers: new Map<string, Array<(event: { payload: Record<string, unknown> | null }) => void>>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    const handlers = eventBus.handlers.get(_eventName) ?? [];
    handlers.push(handler as (event: { payload: Record<string, unknown> | null }) => void);
    eventBus.handlers.set(_eventName, handlers);
    return Promise.resolve(() => {});
  }),
}));

describe("AgentWorkspace", () => {
  beforeEach(() => {
    eventBus.handlers = new Map();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_methods":
          return Promise.resolve([]);
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("starts a design session without exposing transport details", async () => {
    render(<AgentWorkspace />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("start_design_session");
      expect(screen.getByText(/No Method draft exists yet/i)).toBeInTheDocument();
      expect(screen.queryByText(/connected/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Thread thr_123/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Codex Stream/i)).not.toBeInTheDocument();
    });
  });

  it("sends chat through the design bridge", async () => {
    render(<AgentWorkspace />);

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "Help me design a benchmark Method" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("send_design_chat_message", {
        input: { message: "Help me design a benchmark Method" },
      });
      expect(screen.getByText("Help me design a benchmark Method")).toBeInTheDocument();
      expect(screen.queryByText(/Turn turn_456/i)).not.toBeInTheDocument();
    });
  });

  it("renders streamed assistant deltas without event names", async () => {
    render(<AgentWorkspace />);

    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/agentMessage/delta",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "item_1",
          textDelta: "Draft the Method",
          raw: {},
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Draft the Method")).toBeInTheDocument();
      expect(screen.queryByText("item/agentMessage/delta")).not.toBeInTheDocument();
    });
  });

  it("shows a draft panel after chat creates Method state", async () => {
    render(<AgentWorkspace />);

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "Design a rubric benchmark" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("send_design_chat_message", {
        input: { message: "Design a rubric benchmark" },
      });
    });

    eventBus.handlers.get("method-draft-updated")?.forEach((handler) =>
      handler({
        payload: {
          schemaVersion: 1,
          id: "draft-1",
          title: "Rubric benchmark",
          objective: "Compare model answers against a rubric",
          lifecycle: "drafting",
          resources: [
            {
              id: "prompt",
              kind: "prompt",
              label: "Main prompt",
              status: "missing",
              path: "prompts/main.md",
              consumedBy: ["generate"],
            },
          ],
          nodes: [
            { id: "generate", label: "Generate answers", type: "inference", status: "draft", config: {} },
          ],
          edges: [],
          parameters: {},
          providerConfig: {},
          outputs: [],
          metadata: {},
          readiness: {
            status: "drafting",
            blockers: [
              {
                code: "missing_prompt",
                message: "Attach a prompt and data file.",
                resourceId: "prompt",
              },
            ],
            warnings: [],
          },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Generate answers")).toBeInTheDocument();
      expect(screen.getByText("Rubric benchmark")).toBeInTheDocument();
      expect(screen.getByText("Main prompt")).toBeInTheDocument();
      expect(screen.getByText("Attach a prompt and data file.")).toBeInTheDocument();
    });
  });

  it("executes a saved Method and renders execution state", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_methods":
          return Promise.resolve([
            {
              id: "edge-method",
              title: "Edge method",
              contentHash: "hash",
              folderPath: "/tmp/methods/edge-method",
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        case "execute_method":
          return Promise.resolve(42);
        case "list_method_executions":
          return Promise.resolve([
            {
              id: 42,
              methodId: "edge-method",
              methodContentHash: "hash",
              status: "running",
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        case "get_method_execution_nodes":
          return Promise.resolve([
            {
              id: 1,
              executionId: 42,
              nodeId: "generate",
              nodeType: "inference",
              status: "running",
            },
          ]);
        case "get_method_execution_events":
          return Promise.resolve([
            {
              id: 1,
              executionId: 42,
              nodeId: "generate",
              eventType: "node_started",
              payloadJson: {},
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    await screen.findByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("execute_method", { id: "edge-method" });
      expect(screen.getByText("Execution 42")).toBeInTheDocument();
      expect(screen.getAllByText("running").length).toBeGreaterThan(0);
      expect(screen.getByText("node_started")).toBeInTheDocument();
    });
  });

  it("blocks execution when the visible draft differs from the selected saved Method", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve({
            schemaVersion: 1,
            id: "draft-1",
            title: "Edge Model 50% Flash-Card Accuracy Benchmark",
            objective: "Measure accuracy",
            lifecycle: "ready",
            resources: [],
            nodes: [{ id: "generate", label: "Generate", type: "inference", status: "ready", config: null }],
            edges: [],
            parameters: {},
            providerConfig: {},
            outputs: [],
            metadata: {},
            readiness: { status: "ready", blockers: [], warnings: [] },
          });
        case "list_methods":
          return Promise.resolve([
            {
              id: "edge-model-98-flash-card-accuracy-benchmark",
              title: "Edge Model 98% Flash-Card Accuracy Benchmark",
              contentHash: "hash",
              folderPath: "/tmp/methods/edge-model-98-flash-card-accuracy-benchmark",
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    await screen.findByText("Edge Model 50% Flash-Card Accuracy Benchmark");
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/visible draft is 'Edge Model 50%/);
      expect(mockInvoke).not.toHaveBeenCalledWith("execute_method", expect.anything());
    });
  });

  it("saves a ready draft as a Method and selects it for execution", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve({
            schemaVersion: 1,
            id: "draft-1",
            title: "Edge method",
            objective: "Measure accuracy",
            lifecycle: "ready",
            resources: [],
            nodes: [{ id: "generate", label: "Generate", type: "eval", status: "ready", config: {} }],
            edges: [],
            parameters: {},
            providerConfig: {},
            outputs: [],
            metadata: {},
            readiness: { status: "ready", blockers: [], warnings: [] },
          });
        case "list_methods":
          return Promise.resolve([]);
        case "save_current_method_draft":
          return Promise.resolve({
            id: "edge-method",
            title: "Edge method",
            contentHash: "hash",
            folderPath: "/tmp/methods/edge-method",
            createdAt: "2026-05-08T12:00:00Z",
          });
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    await screen.findByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Save Method" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("save_current_method_draft");
      expect(screen.getAllByText("Saved Method 'Edge method'.").length).toBeGreaterThan(0);
    });
  });

  it("shows inline feedback when saving a ready draft fails", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve({
            schemaVersion: 1,
            id: "draft-1",
            title: "Edge method",
            objective: "Measure accuracy",
            lifecycle: "ready",
            resources: [],
            nodes: [{ id: "generate", label: "Generate", type: "eval", status: "ready", config: {} }],
            edges: [],
            parameters: {},
            providerConfig: {},
            outputs: [],
            metadata: {},
            readiness: { status: "ready", blockers: [], warnings: [] },
          });
        case "list_methods":
          return Promise.resolve([]);
        case "save_current_method_draft":
          return Promise.reject("Inference needs a model name.");
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    await screen.findByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Save Method" }));

    await waitFor(() => {
      expect(screen.getAllByText(/I could not save the current Method draft: Inference needs a model name\./)[0])
        .toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Inference needs a model name/);
  });

  it("refreshes execution state when backend events arrive", async () => {
    let nodeStatus = "queued";
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_methods":
          return Promise.resolve([
            {
              id: "edge-method",
              title: "Edge method",
              contentHash: "hash",
              folderPath: "/tmp/methods/edge-method",
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        case "execute_method":
          return Promise.resolve(42);
        case "list_method_executions":
          return Promise.resolve([
            {
              id: 42,
              methodId: "edge-method",
              methodContentHash: "hash",
              status: nodeStatus,
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        case "get_method_execution_nodes":
          return Promise.resolve([
            {
              id: 1,
              executionId: 42,
              nodeId: "generate",
              nodeType: "inference",
              status: nodeStatus,
            },
          ]);
        case "get_method_execution_events":
          return Promise.resolve([
            {
              id: 1,
              executionId: 42,
              nodeId: "generate",
              eventType: nodeStatus === "completed" ? "node_completed" : "node_started",
              payloadJson: {},
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    await screen.findByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(screen.getAllByText("queued").length).toBeGreaterThan(0);
    });
    nodeStatus = "completed";
    eventBus.handlers.get("method-execution-event")?.forEach((handler) =>
      handler({
        payload: {
          executionId: 42,
          nodeId: "generate",
          eventType: "node_completed",
          payload: {},
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
      expect(screen.getByText("node_completed")).toBeInTheDocument();
    });
  });

  it("shows node failure details from execution summaries and events", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_methods":
          return Promise.resolve([
            {
              id: "edge-method",
              title: "Edge method",
              contentHash: "hash",
              folderPath: "/tmp/methods/edge-method",
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        case "execute_method":
          return Promise.resolve(42);
        case "list_method_executions":
          return Promise.resolve([
            {
              id: 42,
              methodId: "edge-method",
              methodContentHash: "hash",
              status: "failed",
              errorMessage: "Inference job failed",
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        case "get_method_execution_nodes":
          return Promise.resolve([
            {
              id: 1,
              executionId: 42,
              nodeId: "generate",
              nodeType: "inference",
              status: "failed",
              errorMessage: "Provider returned 401",
            },
          ]);
        case "get_method_execution_events":
          return Promise.resolve([
            {
              id: 1,
              executionId: 42,
              nodeId: "generate",
              eventType: "node_failed",
              payloadJson: { error: "Provider returned 401" },
              createdAt: "2026-05-08T12:00:00Z",
            },
          ]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    await screen.findByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(screen.getAllByText("Provider returned 401").length).toBeGreaterThan(0);
      expect(screen.getByText("node_failed")).toBeInTheDocument();
    });
  });

  it("shows recoverable connection failures without losing the conversation", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_design_session") return Promise.resolve({ threadId: "thr_123" });
      if (command === "send_design_chat_message") return Promise.reject(new Error("process exited"));
      return Promise.resolve(null);
    });

    render(<AgentWorkspace />);

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText("hello")).toBeInTheDocument();
      expect(screen.getByText(/I could not reach the design agent/i)).toBeInTheDocument();
      expect(screen.queryByText("failed")).not.toBeInTheDocument();
    });
  });

  it("reconnects the design session after a project folder opens", async () => {
    let startAttempts = 0;
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          startAttempts += 1;
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_methods":
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<AgentWorkspace />);

    await waitFor(() => {
      expect(screen.queryByText(/Open a project folder before starting/i)).not.toBeInTheDocument();
    });
    eventBus.handlers.get("project-opened")?.forEach((handler) =>
      handler({ payload: {} }),
    );

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    await waitFor(() => {
      expect(startAttempts).toBe(1);
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    });
    fireEvent.change(input, { target: { value: "create a Method" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("send_design_chat_message", {
        input: { message: "create a Method" },
      });
    });
  });
});
