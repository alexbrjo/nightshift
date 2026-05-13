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
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
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
      expect(screen.queryByText("Methods")).not.toBeInTheDocument();
      expect(screen.queryByText(/No Method draft exists yet/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/connected/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Thread thr_123/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Codex Stream/i)).not.toBeInTheDocument();
    });
  });

  it("uses an accessible resizable panel group for the Method graph", async () => {
    render(<AgentWorkspace />);

    const separator = await screen.findByRole("separator", { name: "Resize Method graph panel" });
    const main = separator.closest(".agent-chat-main") as HTMLElement;

    expect(main).toBeInTheDocument();
    expect(main.style.getPropertyValue("--agent-graph-width")).toBe("");
    expect(screen.getByRole("combobox", { name: "Saved Method" })).toBeInTheDocument();
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
      expect(screen.getAllByText("Help me design a benchmark Method").length).toBeGreaterThan(0);
      expect(screen.queryByText(/Turn turn_456/i)).not.toBeInTheDocument();
    });
  });

  it("renders user messages and thinking state as passive chat history", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return new Promise(() => {});
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
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

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "search the folder" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      const userMessage = screen.getAllByText("search the folder")
        .find((element) => element.closest(".agent-message.user"));
      expect(userMessage?.closest(".agent-message.user")).toHaveClass("completed");
      expect(screen.getByText("Thinking")).toHaveClass("agent-thinking-indicator");
      expect(screen.getByText("Thinking").closest(".agent-message.system")).toHaveClass("pending");
    });
  });

  it("uses a wrapping expandable textarea for long planning prompts", async () => {
    render(<AgentWorkspace />);

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    expect(input.tagName).toBe("TEXTAREA");

    fireEvent.change(input, {
      target: {
        value: "Can edge models get to 50% accuracy?\nTest 2 local model sizes and compare failure modes.",
      },
    });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(input).toHaveValue(
      "Can edge models get to 50% accuracy?\nTest 2 local model sizes and compare failure modes.",
    );

    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("send_design_chat_message", {
        input: {
          message: "Can edge models get to 50% accuracy?\nTest 2 local model sizes and compare failure modes.",
        },
      });
    });
  });

  it("shows composer context and planning agent model metrics below the textarea", async () => {
    render(<AgentWorkspace />);

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, {
      target: { value: "Measure accuracy for local models with controlled variables." },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Planning agent metrics")).toHaveTextContent("context tokens");
      expect(screen.getByLabelText("Planning agent metrics")).toHaveTextContent("gpt-5.5");
      expect(screen.getByLabelText("Planning agent metrics")).toHaveTextContent("reasoning auto");
      expect(screen.getByLabelText("Planning agent metrics")).toHaveTextContent("20 tool loops");
    });
    expect(screen.getByRole("button", { name: "Send" }).closest(".agent-chat-input-footer")).toBeInTheDocument();
  });

  it("persists planning chats across remounts", async () => {
    const { unmount } = render(<AgentWorkspace />);

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "Persistent benchmark plan" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getAllByText("Persistent benchmark plan").length).toBeGreaterThan(0);
      expect(
        screen.getAllByText("Persistent benchmark plan")
          .some((element) => element.closest(".agent-chat-list-item")),
      ).toBe(true);
    });

    unmount();
    render(<AgentWorkspace />);

    await waitFor(() => {
      expect(screen.getAllByText("Persistent benchmark plan").length).toBeGreaterThan(0);
    });
    expect(screen.getByLabelText("Planning chats")).toBeInTheDocument();
  });

  it("creates and switches between planning chats from the sidebar", async () => {
    render(<AgentWorkspace />);

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "First plan" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(screen.getAllByText("First plan").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "+ New" }));
    expect(document.querySelector(".agent-chat-scroll")).not.toHaveTextContent("First plan");
    expect(screen.getByText("New planning chat").closest(".agent-chat-list-item")).toHaveClass("selected");

    fireEvent.change(screen.getByPlaceholderText(/Describe or refine/i), { target: { value: "Second plan" } });
    fireEvent.submit(screen.getByPlaceholderText(/Describe or refine/i).closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(screen.getAllByText("Second plan").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByText("First plan").closest(".agent-chat-list-item") as HTMLElement);
    const scroll = document.querySelector(".agent-chat-scroll") as HTMLElement;
    expect(scroll).toHaveTextContent("First plan");
    expect(scroll).not.toHaveTextContent("Second plan");
  });

  it("routes in-flight agent events to the chat that submitted the turn", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return new Promise(() => {});
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
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

    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "First active plan" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getAllByText("First active plan").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "+ New" }));
    expect(document.querySelector(".agent-chat-scroll")).not.toHaveTextContent("First active plan");

    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/completed",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "assistant_1",
          messageText: "Original chat response",
          raw: {},
        },
      }),
    );

    await waitFor(() => {
      expect(document.querySelector(".agent-chat-scroll")).not.toHaveTextContent("Original chat response");
    });

    fireEvent.click(screen.getByText("First active plan").closest(".agent-chat-list-item") as HTMLElement);
    expect(document.querySelector(".agent-chat-scroll")).toHaveTextContent("Original chat response");
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

  it("renders assistant Markdown for readable chat output", async () => {
    render(<AgentWorkspace />);

    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/completed",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "item_1",
          messageText: "Updated the draft:\n\n- Added `prompt.jinja2`\n- Set **model** options",
          raw: {},
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("list").length).toBeGreaterThan(0);
      expect(screen.getByText("prompt.jinja2")).toBeInTheDocument();
      expect(screen.getByText("model")).toBeInTheDocument();
      expect(screen.queryByText(/- Added `prompt\.jinja2`/)).not.toBeInTheDocument();
    });
  });

  it("ignores unsafe HTML in assistant Markdown", async () => {
    render(<AgentWorkspace />);

    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/completed",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "item_1",
          messageText: "Safe summary.<script>alert('bad')</script><img src=x onerror=alert(1)> [bad](javascript:alert(1))",
          raw: {},
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Safe summary.")).toBeInTheDocument();
      expect(document.querySelector("script")).not.toBeInTheDocument();
      expect(document.querySelector("img")).not.toBeInTheDocument();
      expect(screen.getByText("bad").closest("a")).toBeNull();
      expect(screen.queryByText(/alert\('bad'\)/)).not.toBeInTheDocument();
    });
  });

  it("renders planning trace summaries and tool call status", async () => {
    render(<AgentWorkspace />);

    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/reasoningSummary/completed",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "reasoning_1",
          messageText: "Checked the draft graph and missing resources.",
          traceKind: "reasoning",
          status: "completed",
          raw: {},
        },
      }),
    );
    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/toolCall/started",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "tool_1",
          toolName: "replace_method_draft_graph",
          traceKind: "tool",
          status: "started",
          raw: {},
        },
      }),
    );
    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/toolCall/completed",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "tool_1",
          toolName: "replace_method_draft_graph",
          traceKind: "tool",
          status: "completed",
          durationMs: 42,
          outputSummary: "Draft 'Edge method' - 2 nodes - 1 resource",
          toolArguments: {
            workflow: { nodes: [{ id: "generate" }] },
          },
          toolOutput: {
            ok: true,
            result: { draft: { title: "Edge method" } },
          },
          raw: {},
        },
      }),
    );
    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/toolCall/completed",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "tool_2",
          toolName: "replace_method_draft_graph",
          traceKind: "tool",
          status: "completed",
          durationMs: 7,
          outputSummary: "Draft 'Edge method' - 2 nodes - 2 resources",
          raw: {},
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Checked the draft graph and missing resources.")).toBeInTheDocument();
      expect(screen.getByText("2 tool calls")).toBeInTheDocument();
      expect(screen.getAllByText("replace_method_draft_graph").length).toBeGreaterThan(0);
      expect(screen.getByText("42 ms")).toBeInTheDocument();
      expect(screen.getByText("Draft 'Edge method' - 2 nodes - 1 resource")).toBeInTheDocument();
      expect(screen.getByText("Parameters")).toBeInTheDocument();
      expect(screen.getByText("Output")).toBeInTheDocument();
      expect(screen.queryByText("item/toolCall/completed")).not.toBeInTheDocument();
    });

    const toolGroup = screen.getByText("2 tool calls").closest("details") as HTMLDetailsElement;
    fireEvent.click(screen.getByText("2 tool calls"));
    expect(toolGroup.open).toBe(true);

    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) =>
      handler({
        payload: {
          eventType: "item/toolCall/completed",
          threadId: "thr_123",
          turnId: "turn_456",
          itemId: "tool_3",
          toolName: "explain_current_method_draft",
          traceKind: "tool",
          status: "completed",
          durationMs: 3,
          outputSummary: "Ready with no blockers",
          raw: {},
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("3 tool calls")).toBeInTheDocument();
      expect(toolGroup.open).toBe(true);
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
          schema_version: 2,
          id: "draft-1",
          title: "Rubric benchmark",
          objective: "Compare model answers against a rubric",
          workflow: {
            nodes: [
              { id: "prompt", label: "Main prompt", type: "resource", kind: "prompt" },
              { id: "generate", label: "Generate answers", type: "inference", depends_on: ["prompt"], config: {} },
            ],
          },
          parameters: {},
          provider: {},
          outputs: [],
          metadata: {},
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Generate answers")).toBeInTheDocument();
      expect(screen.queryByText("Rubric benchmark")).not.toBeInTheDocument();
      expect(screen.getByText("Main prompt")).toBeInTheDocument();
      expect(screen.getByText("Attach prompt for 'Main prompt'.")).toBeInTheDocument();
    });
  });

  it("executes a saved Method and renders execution state", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve({
            schema_version: 2,
            id: "edge-method",
            title: "Edge method",
            objective: "Measure accuracy",
            workflow: {
              nodes: [{ id: "generate", label: "Generate", type: "inference", config: {} }],
            },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
          });
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

    await screen.findAllByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("execute_method", { id: "edge-method" });
      expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
      expect(screen.queryByText("Execution 42")).not.toBeInTheDocument();
      expect(screen.queryByText("Started Method execution 42.")).not.toBeInTheDocument();
      expect(screen.queryByText("node_started")).not.toBeInTheDocument();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("get_method_execution_events", { executionId: 42 });
  });

  it("blocks execution when the visible draft differs from the selected saved Method", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve({
            schema_version: 1,
            id: "draft-1",
            title: "Edge Model 50% Flash-Card Accuracy Benchmark",
            objective: "Measure accuracy",
            workflow: {
              nodes: [{ id: "generate", label: "Generate", type: "inference", config: {} }],
            },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
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

    await screen.findByRole("option", { name: "Edge Model 98% Flash-Card Accuracy Benchmark" });
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
            schema_version: 1,
            id: "draft-1",
            title: "Edge method",
            objective: "Measure accuracy",
            workflow: {
              nodes: [{ id: "generate", label: "Generate", type: "eval", config: {} }],
            },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
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

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save Method" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Method" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("save_current_method_draft");
      expect(screen.getByRole("combobox", { name: "Saved Method" })).toHaveValue("edge-method");
      expect(screen.queryByText("Saved Method 'Edge method'.")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  it("shows inline feedback when saving a ready draft fails", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve({
            schema_version: 1,
            id: "draft-1",
            title: "Edge method",
            objective: "Measure accuracy",
            workflow: {
              nodes: [{ id: "generate", label: "Generate", type: "eval", config: {} }],
            },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
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

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save Method" })).toBeEnabled();
    });
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
          return Promise.resolve({
            schema_version: 1,
            id: "edge-method",
            title: "Edge method",
            objective: "Measure accuracy",
            workflow: {
              nodes: [{ id: "generate", label: "Generate", type: "inference", config: {} }],
            },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
          });
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

    await screen.findAllByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(screen.getAllByText("Queued").length).toBeGreaterThan(0);
      expect(screen.queryByText("Execution 42")).not.toBeInTheDocument();
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
      expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
      expect(screen.queryByText("node_completed")).not.toBeInTheDocument();
    });
  });

  it("shows node failure status in the graph without raw execution text", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_current_method_draft":
          return Promise.resolve({
            schema_version: 1,
            id: "edge-method",
            title: "Edge method",
            objective: "Measure accuracy",
            workflow: {
              nodes: [{ id: "generate", label: "Generate", type: "inference", config: {} }],
            },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
          });
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

    await screen.findAllByText("Edge method");
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
      expect(screen.queryByText("Provider returned 401")).not.toBeInTheDocument();
      expect(screen.queryByText("node_failed")).not.toBeInTheDocument();
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
      expect(screen.getAllByText("hello").length).toBeGreaterThan(0);
      expect(screen.getByText(/I could not reach the design agent/i)).toBeInTheDocument();
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
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
