import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../setupTests";
import AgentWorkspace, {
  ChatPanel,
  MethodExecutionGraphPanel,
  MethodWorkspaceProvider,
  shouldPersistProjectConversations,
} from "./AgentWorkspace";

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

async function emitCodexEvent(payload: Record<string, unknown>) {
  await waitFor(() => {
    expect(eventBus.handlers.get("codex-app-server-event")?.length ?? 0).toBeGreaterThan(0);
  });
  await act(async () => {
    eventBus.handlers.get("codex-app-server-event")?.forEach((handler) => handler({ payload }));
  });
}

describe("AgentWorkspace", () => {
  let projectConversations: unknown | null;

  beforeEach(() => {
    eventBus.handlers = new Map();
    projectConversations = null;
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((command: string, payload?: { conversations?: unknown }) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_conversations":
          return Promise.resolve(projectConversations);
        case "save_project_conversations":
          projectConversations = payload?.conversations ?? null;
          return Promise.resolve(null);
        case "get_current_method_draft":
          return Promise.resolve(null);
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

  it("renders welcome guidance without storing it as a chat", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText(/Describe the Method you want to design/)).toBeInTheDocument();
    expect(screen.queryByText("New planning chat")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("load_project_conversations");
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("save_project_conversations", expect.anything());
  });

  it("persists an empty conversation list after saved chats are removed", () => {
    expect(shouldPersistProjectConversations(true, 0, 1)).toBe(true);
    expect(shouldPersistProjectConversations(true, 0, 0)).toBe(false);
    expect(shouldPersistProjectConversations(false, 1, 1)).toBe(false);
  });

  it("uses an accessible resizable panel group for the Method graph", async () => {
    render(<AgentWorkspace />);

    const separator = await screen.findByRole("separator", { name: "Resize Method graph panel" });
    const main = separator.closest(".agent-chat-main") as HTMLElement;

    expect(main).toBeInTheDocument();
    expect(main.style.getPropertyValue("--agent-graph-width")).toBe("");
    expect(screen.queryByRole("button", { name: "Execute Draft" })).not.toBeInTheDocument();
  });

  it("refreshes execution graph panels from execution events without polling", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    let executionStatus = "running";
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_conversations":
          return Promise.resolve(null);
        case "save_project_conversations":
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_method_executions":
          return Promise.resolve([{ id: 42, methodId: "method-hash", status: executionStatus, createdAt: "2026-05-13T00:00:00Z" }]);
        case "get_execution_method":
          return Promise.resolve({
            schema_version: 2,
            id: "method-hash",
            title: "Evented Method",
            objective: "Verify execution refresh",
            workflow: { nodes: [{ id: "generate", label: "Generate", type: "inference", config: {} }] },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
          });
        case "get_method_execution_nodes":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(
      <MethodWorkspaceProvider>
        <MethodExecutionGraphPanel executionId={42} />
      </MethodWorkspaceProvider>,
    );

    expect(await screen.findByText("running")).toBeInTheDocument();
    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 5000)).toBe(false);
    const initialLoads = mockInvoke.mock.calls.filter(([command]) => command === "list_method_executions").length;

    executionStatus = "completed";
    await waitFor(() => {
      expect(eventBus.handlers.get("method-execution-event")?.length ?? 0).toBeGreaterThan(0);
    });
    await act(async () => {
      eventBus.handlers.get("method-execution-event")?.forEach((handler) =>
        handler({ payload: { executionId: 42 } }),
      );
    });

    expect(await screen.findByText("completed")).toBeInTheDocument();
    expect(mockInvoke.mock.calls.filter(([command]) => command === "list_method_executions").length)
      .toBeGreaterThan(initialLoads);
    setIntervalSpy.mockRestore();
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

  it("keeps separate mounted ChatPanel instances independent before they become saved chats", async () => {
    render(
      <MethodWorkspaceProvider>
        <ChatPanel />
        <ChatPanel />
      </MethodWorkspaceProvider>,
    );

    const inputs = await screen.findAllByPlaceholderText(/Describe or refine/i);
    fireEvent.change(inputs[0], { target: { value: "Independent first draft" } });
    fireEvent.change(inputs[1], { target: { value: "Independent second draft" } });

    expect(inputs[0]).toHaveValue("Independent first draft");
    expect(inputs[1]).toHaveValue("Independent second draft");

    fireEvent.submit(inputs[0].closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("send_design_chat_message", {
        input: { message: "Independent first draft" },
      });
    });
    expect(inputs[1]).toHaveValue("Independent second draft");
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

    await emitCodexEvent({
      eventType: "item/completed",
      threadId: "thr_123",
      turnId: "turn_456",
      itemId: "assistant_1",
      messageText: "Original chat response",
      raw: {},
    });

    await waitFor(() => {
      expect(document.querySelector(".agent-chat-scroll")).not.toHaveTextContent("Original chat response");
    });

    fireEvent.click(screen.getByText("First active plan").closest(".agent-chat-list-item") as HTMLElement);
    expect(document.querySelector(".agent-chat-scroll")).toHaveTextContent("Original chat response");
  });

  it("renders streamed assistant deltas without event names", async () => {
    render(<AgentWorkspace />);

    await emitCodexEvent({
      eventType: "item/agentMessage/delta",
      threadId: "thr_123",
      turnId: "turn_456",
      itemId: "item_1",
      textDelta: "Draft the Method",
      raw: {},
    });

    await waitFor(() => {
      expect(screen.getByText("Draft the Method")).toBeInTheDocument();
      expect(screen.queryByText("item/agentMessage/delta")).not.toBeInTheDocument();
    });
  });

  it("renders assistant Markdown for readable chat output", async () => {
    render(<AgentWorkspace />);

    await emitCodexEvent({
      eventType: "item/completed",
      threadId: "thr_123",
      turnId: "turn_456",
      itemId: "item_1",
      messageText: "Updated the draft:\n\n- Added `prompt.jinja2`\n- Set **model** options",
      raw: {},
    });

    await waitFor(() => {
      expect(screen.getAllByRole("list").length).toBeGreaterThan(0);
      expect(screen.getByText("prompt.jinja2")).toBeInTheDocument();
      expect(screen.getByText("model")).toBeInTheDocument();
      expect(screen.queryByText(/- Added `prompt\.jinja2`/)).not.toBeInTheDocument();
    });
  });

  it("ignores unsafe HTML in assistant Markdown", async () => {
    render(<AgentWorkspace />);

    await emitCodexEvent({
      eventType: "item/completed",
      threadId: "thr_123",
      turnId: "turn_456",
      itemId: "item_1",
      messageText: "Safe summary.<script>alert('bad')</script><img src=x onerror=alert(1)> [bad](javascript:alert(1))",
      raw: {},
    });

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

    await emitCodexEvent({
      eventType: "item/reasoningSummary/completed",
      threadId: "thr_123",
      turnId: "turn_456",
      itemId: "reasoning_1",
      messageText: "Checked the draft graph and missing resources.",
      traceKind: "reasoning",
      status: "completed",
      raw: {},
    });
    await emitCodexEvent({
      eventType: "item/toolCall/started",
      threadId: "thr_123",
      turnId: "turn_456",
      itemId: "tool_1",
      toolName: "replace_method_draft_graph",
      traceKind: "tool",
      status: "started",
      raw: {},
    });
    await emitCodexEvent({
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
    });
    await emitCodexEvent({
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
    });

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

    await emitCodexEvent({
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
    });

    await waitFor(() => {
      expect(screen.getByText("3 tool calls")).toBeInTheDocument();
      expect(toolGroup.open).toBe(true);
    });
  });

  it("only colors the failed tool status inside a mixed tool trace group", async () => {
    render(<AgentWorkspace />);

    for (const payload of [
      {
        eventType: "item/toolCall/completed",
        threadId: "thr_123",
        turnId: "turn_456",
        itemId: "tool_ok",
        toolName: "create_method_draft",
        traceKind: "tool",
        status: "completed",
        durationMs: 2,
        raw: {},
      },
      {
        eventType: "item/toolCall/completed",
        threadId: "thr_123",
        turnId: "turn_456",
        itemId: "tool_failed",
        toolName: "replace_method_draft_graph",
        traceKind: "tool",
        status: "failed",
        durationMs: 0,
        raw: {},
      },
    ]) {
      await emitCodexEvent(payload);
    }

    const groupLabel = await screen.findByText("2 tool calls");
    fireEvent.click(groupLabel);

    expect(groupLabel.closest("summary")).not.toHaveClass("failed");
    expect(screen.getByText("completed")).not.toHaveClass("failed");
    expect(screen.getByText("failed")).toHaveClass("agent-tool-trace-status", "failed");
  });

  it("announces project file and Method draft changes from completed Method tools", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<AgentWorkspace />);

    await emitCodexEvent({
      eventType: "item/toolCall/completed",
      threadId: "thr_123",
      turnId: "turn_456",
      itemId: "tool_create",
      toolName: "create_method_draft",
      traceKind: "tool",
      status: "completed",
      raw: {},
    });

    await waitFor(() => {
      const eventTypes = dispatchSpy.mock.calls.map(([event]) => event.type);
      expect(eventTypes).toContain("nightshift-project-files-changed");
      expect(eventTypes).toContain("nightshift-method-draft-mutated");
      expect(mockInvoke).toHaveBeenCalledWith("get_current_method_draft");
    });

    dispatchSpy.mockRestore();
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

  it("does not expose draft execution controls from the chat workspace", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "start_design_session") return Promise.resolve({ threadId: "thr_123" });
      if (command === "get_current_method_draft") {
        return Promise.resolve({
          schema_version: 2,
          id: "edge-method",
          title: "Edge method",
          objective: "Measure accuracy",
          workflow: { nodes: [{ id: "generate", label: "Generate", type: "inference", config: {} }] },
          parameters: {},
          provider: {},
          outputs: [],
          metadata: {},
        });
      }
      return Promise.resolve(null);
    });

    render(<AgentWorkspace />);

    await screen.findByText("Generate");
    expect(screen.queryByRole("button", { name: "Execute Draft" })).not.toBeInTheDocument();
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
      const errorMessage = screen.getByText(/I could not reach the design agent/i);
      expect(errorMessage).toBeInTheDocument();
      expect(errorMessage.closest(".agent-message.system")).toHaveClass("failed");
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
