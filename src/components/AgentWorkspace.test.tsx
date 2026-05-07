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
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        case "get_current_method_draft":
          return Promise.resolve(null);
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
});
