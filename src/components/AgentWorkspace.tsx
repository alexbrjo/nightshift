import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodexAppServerEvent, CodexAppServerSession, CodexTurnSummary, MethodDraft } from "../database";

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

function draftStatusLabel(draft: MethodDraft) {
  if (draft.readiness.status === "ready") return "Ready";
  return "Drafting";
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

        <aside className="agent-visual-panel">
          <div className="agent-visual-header">
            <div>
              <h2>Methods</h2>
              <p>{draft ? draft.id : "No draft"}</p>
            </div>
            {draft && <span>{draftStatusLabel(draft)}</span>}
          </div>

          {draft ? (
            <div className="method-draft-view">
              <section className="method-draft-hero">
                <h3>{draft.title}</h3>
                <p>{draft.objective || "Objective not set"}</p>
              </section>

              <div className="method-summary-strip">
                <div>
                  <strong>{draft.nodes.length}</strong>
                  <span>Nodes</span>
                </div>
                <div>
                  <strong>{draft.edges.length}</strong>
                  <span>Edges</span>
                </div>
                <div>
                  <strong>{draft.resources.length}</strong>
                  <span>Resources</span>
                </div>
              </div>

              <section className="agent-graph" aria-label="Draft Method graph">
                {draft.nodes.length > 0 ? (
                  draft.nodes.map((node) => {
                    const incoming = draft.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
                    return (
                      <article key={node.id} className="agent-graph-node status-drafting">
                        <div>
                          <strong>{node.label || node.id}</strong>
                          <span>{node.type}</span>
                          <em>{incoming.length ? `Depends on ${incoming.join(", ")}` : "No dependencies"}</em>
                        </div>
                        <span>{node.status || "draft"}</span>
                      </article>
                    );
                  })
                ) : (
                  <div className="agent-empty-visual">No nodes yet.</div>
                )}
              </section>

              <section className="method-resource-list">
                <h3>Resources</h3>
                {draft.resources.length > 0 ? (
                  draft.resources.map((resource) => (
                    <article key={resource.id}>
                      <div>
                        <strong>{resource.label}</strong>
                        <span>{resource.kind}</span>
                      </div>
                      <span>{resource.status}</span>
                    </article>
                  ))
                ) : (
                  <p className="agent-muted">No resources attached.</p>
                )}
              </section>

              <section className="agent-blockers">
                <h3>Readiness</h3>
                {draft.readiness.blockers.map((blocker) => (
                  <p key={blocker.code} className="method-issue blocker">
                    {blocker.message}
                  </p>
                ))}
                {draft.readiness.warnings.map((warning) => (
                  <p key={warning.code} className="method-issue warning">
                    {warning.message}
                  </p>
                ))}
                {draft.readiness.blockers.length === 0 && draft.readiness.warnings.length === 0 && (
                  <p className="method-issue ready">Ready for validation.</p>
                )}
              </section>
            </div>
          ) : (
            <div className="agent-empty-visual">No Method draft exists yet.</div>
          )}
        </aside>
      </main>
    </div>
  );
}
