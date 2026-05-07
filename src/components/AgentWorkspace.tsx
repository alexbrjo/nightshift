import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodexAppServerEvent, CodexAppServerSession, CodexTurnSummary, MethodDraft } from "../database";
import MethodGraph from "./MethodGraph";

interface ChatMessage {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
  status?: "pending" | "streaming" | "completed" | "failed";
}

function appendDelta(messages: ChatMessage[], itemId: string, delta: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === itemId);
  if (index === -1) {
    return [...messages, { id: itemId, role: "assistant", text: delta, status: "streaming" }];
  }
  return messages.map((message, currentIndex) =>
    currentIndex === index
      ? { ...message, text: `${message.text}${delta}`, status: "streaming" }
      : message,
  );
}

function upsertAssistantMessage(messages: ChatMessage[], itemId: string, text: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === itemId);
  if (index === -1) {
    return [...messages, { id: itemId, role: "assistant", text, status: "completed" }];
  }
  return messages.map((message, currentIndex) =>
    currentIndex === index ? { ...message, text, status: "completed" } : message,
  );
}

function userFacingError(err: unknown) {
  return `I could not reach the design agent: ${String(err)}`;
}

export default function AgentWorkspace() {
  const [session, setSession] = useState<CodexAppServerSession | null>(null);
  const [activeTurn, setActiveTurn] = useState<CodexTurnSummary | null>(null);
  const [draft, setDraft] = useState<MethodDraft | null>(null);
  const [input, setInput] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Describe the Method you want to design. I can help shape the workflow and keep the draft state visible beside chat.",
      status: "completed",
    },
  ]);

  const addSystemMessage = useCallback((text: string, status: ChatMessage["status"] = "completed") => {
    setMessages((current) => [
      ...current,
      { id: `system-${Date.now()}-${current.length}`, role: "system", text, status },
    ]);
  }, []);

  const startSession = useCallback(async () => {
    setIsConnecting(true);
    try {
      const nextSession = await invoke<CodexAppServerSession>("start_design_session");
      setSession(nextSession);
      return nextSession;
    } catch (err) {
      addSystemMessage(userFacingError(err), "failed");
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [addSystemMessage]);

  useEffect(() => {
    void startSession();
  }, [startSession]);

  useEffect(() => {
    let cancelled = false;
    invoke<MethodDraft | null>("get_current_method_draft")
      .then((currentDraft) => {
        if (!cancelled) setDraft(currentDraft);
      })
      .catch((err) => {
        if (!cancelled) addSystemMessage(`I could not load the current Method draft: ${String(err)}`, "failed");
      });
    return () => {
      cancelled = true;
    };
  }, [addSystemMessage]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<MethodDraft | null>("method-draft-updated", (event) => {
      if (!cancelled) setDraft(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        addSystemMessage(`I could not subscribe to Method draft updates: ${String(err)}`, "failed");
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addSystemMessage]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<CodexAppServerEvent>("codex-app-server-event", (event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.eventType === "item/agentMessage/delta" && payload.textDelta) {
        setMessages((current) =>
          appendDelta(
            current,
            payload.itemId ?? `assistant-${payload.turnId ?? Date.now()}`,
            payload.textDelta ?? "",
          ),
        );
      }
      if (payload.eventType === "item/completed" && payload.messageText) {
        setMessages((current) =>
          upsertAssistantMessage(
            current,
            payload.itemId ?? `assistant-${payload.turnId ?? Date.now()}`,
            payload.messageText ?? "",
          ),
        );
      }
      if (payload.eventType === "turn/completed") {
        setIsSending(false);
        setActiveTurn(null);
        if (payload.status === "failed") {
          addSystemMessage(payload.errorMessage ?? "The design turn failed.", "failed");
        }
      }
      if (payload.eventType.startsWith("connection/") && payload.errorMessage) {
        setIsSending(false);
        setActiveTurn(null);
        addSystemMessage(userFacingError(payload.errorMessage), "failed");
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        addSystemMessage(userFacingError(err), "failed");
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addSystemMessage]);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    setIsSending(true);
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", text, status: "completed" },
      { id: `pending-${Date.now()}`, role: "system", text: "Thinking...", status: "pending" },
    ]);
    try {
      const turn = await invoke<CodexTurnSummary>("send_design_chat_message", { input: { message: text } });
      setActiveTurn(turn);
      setSession({ threadId: turn.threadId });
      setMessages((current) => current.filter((message) => message.status !== "pending"));
    } catch (err) {
      setIsSending(false);
      setMessages((current) => [
        ...current.filter((message) => message.status !== "pending"),
        { id: `send-error-${Date.now()}`, role: "system", text: userFacingError(err), status: "failed" },
      ]);
    }
  };

  return (
    <div className="agent-chat-workspace">
      <main className="agent-chat-main">
        <section className="agent-chat-panel">
          <div className="agent-chat-title">Methods</div>
          <div className="agent-chat-scroll">
            {messages.map((message) => (
              <div key={message.id} className={`agent-message ${message.role} ${message.status ?? ""}`}>
                {message.text}
              </div>
            ))}
          </div>

          <form
            className="agent-chat-input"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Describe or refine a Method"
              disabled={isSending && Boolean(activeTurn)}
            />
            <button type="submit" disabled={isSending || isConnecting || !session}>
              {isSending ? "Sending" : "Send"}
            </button>
          </form>
        </section>

        <aside className="agent-visual-panel agent-graph-sidebar">
          {draft ? (
            <div className="method-draft-panel">
              <div className="method-draft-header">
                <div>
                  <span>{draft.lifecycle}</span>
                  <strong>{draft.title}</strong>
                </div>
                <span>{draft.readiness.blockers.length} blockers</span>
              </div>
              <MethodGraph draft={draft} />
            </div>
          ) : (
            <div className="agent-empty-visual">No Method draft exists yet.</div>
          )}
        </aside>
      </main>
    </div>
  );
}
