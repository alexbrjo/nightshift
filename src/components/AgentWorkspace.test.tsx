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
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("starts a design session without exposing transport details", async () => {
    render(<AgentWorkspace />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("start_design_session");
      expect(screen.getByText(/Drafting tools coming next/i)).toBeInTheDocument();
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

    eventBus.handlers.forEach((handler) =>
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
