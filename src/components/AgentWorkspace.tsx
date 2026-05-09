import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CodexAppServerEvent,
  CodexAppServerSession,
  CodexTurnSummary,
  MethodDraft,
  MethodExecutionEventSummary,
  MethodExecutionNodeSummary,
  MethodExecutionSummary,
  MethodSummary,
} from "../database";
import MethodGraph from "./MethodGraph";

interface ChatMessage {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
  status?: "pending" | "streaming" | "completed" | "failed";
}

interface MethodExecutionEventPayload {
  executionId: number;
  nodeId?: string;
  eventType: string;
  payload: Record<string, unknown>;
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

function isMethodDraft(value: unknown): value is MethodDraft {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && "id" in value
      && "readiness" in value,
  );
}

function eventDetail(event: MethodExecutionEventSummary): string | null {
  const payload = event.payloadJson;
  const error = typeof payload?.error === "string" ? payload.error : null;
  if (error) return error;
  const status = typeof payload?.status === "string" ? payload.status : null;
  const message = typeof payload?.message === "string" ? payload.message : null;
  if (status && message) return `${status}: ${message}`;
  if (message) return message;
  if (status) return status;
  return null;
}

function slugForMethodId(value: string) {
  const slug = value
    .split("")
    .map((char) => (/[a-z0-9]/i.test(char) ? char.toLowerCase() : "-"))
    .join("")
    .split("-")
    .filter(Boolean)
    .join("-");
  return slug || "method";
}

export default function AgentWorkspace() {
  const [session, setSession] = useState<CodexAppServerSession | null>(null);
  const [activeTurn, setActiveTurn] = useState<CodexTurnSummary | null>(null);
  const [draft, setDraft] = useState<MethodDraft | null>(null);
  const [methods, setMethods] = useState<MethodSummary[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [activeExecutionId, setActiveExecutionId] = useState<number | null>(null);
  const [executionNodes, setExecutionNodes] = useState<MethodExecutionNodeSummary[]>([]);
  const [executionEvents, setExecutionEvents] = useState<MethodExecutionEventSummary[]>([]);
  const [executionStatus, setExecutionStatus] = useState<string>("idle");
  const [isSavingMethod, setIsSavingMethod] = useState(false);
  const [isExecutingMethod, setIsExecutingMethod] = useState(false);
  const [methodActionFeedback, setMethodActionFeedback] = useState<{
    tone: "info" | "success" | "error";
    text: string;
  } | null>(null);
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

  const loadCurrentDraft = useCallback(async () => {
    try {
      const currentDraft = await invoke<MethodDraft | null>("get_current_method_draft");
      setDraft(isMethodDraft(currentDraft) ? currentDraft : null);
    } catch (err) {
      addSystemMessage(`I could not load the current Method draft: ${String(err)}`, "failed");
    }
  }, [addSystemMessage]);

  const loadMethods = useCallback(async () => {
    try {
      const result = await invoke<MethodSummary[] | null>("list_methods");
      const savedMethods = Array.isArray(result) ? result : [];
      setMethods(savedMethods);
      setSelectedMethodId((current) => current || savedMethods[0]?.id || "");
    } catch (err) {
      addSystemMessage(`I could not load saved Methods: ${String(err)}`, "failed");
    }
  }, [addSystemMessage]);

  const refreshExecution = useCallback(
    async (executionId: number) => {
      try {
        const [executions, nodes, events] = await Promise.all([
          invoke<MethodExecutionSummary[]>("list_method_executions", { methodId: selectedMethodId || null }),
          invoke<MethodExecutionNodeSummary[]>("get_method_execution_nodes", { executionId }),
          invoke<MethodExecutionEventSummary[]>("get_method_execution_events", { executionId }),
        ]);
        const currentExecution = executions.find((execution) => execution.id === executionId);
        setExecutionStatus(currentExecution?.status ?? "running");
        setExecutionNodes(nodes);
        setExecutionEvents(events);
      } catch (err) {
        addSystemMessage(`I could not refresh Method execution ${executionId}: ${String(err)}`, "failed");
      }
    },
    [addSystemMessage, selectedMethodId],
  );

  useEffect(() => {
    void loadMethods();
  }, [loadMethods]);

  useEffect(() => {
    void loadCurrentDraft();
  }, [loadCurrentDraft]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("project-opened", () => {
      if (cancelled) return;
      void startSession();
      void loadCurrentDraft();
      void loadMethods();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        addSystemMessage(`I could not subscribe to project changes: ${String(err)}`, "failed");
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addSystemMessage, loadCurrentDraft, loadMethods, startSession]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<MethodDraft | null>("method-draft-updated", (event) => {
      if (!cancelled) setDraft(isMethodDraft(event.payload) ? event.payload : null);
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
    listen<MethodExecutionEventPayload>("method-execution-event", (event) => {
      if (cancelled || event.payload.executionId !== activeExecutionId) return;
      void refreshExecution(event.payload.executionId);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        addSystemMessage(`I could not subscribe to Method execution updates: ${String(err)}`, "failed");
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeExecutionId, addSystemMessage, refreshExecution]);

  useEffect(() => {
    if (!activeExecutionId || ["completed", "completed_with_errors", "failed", "cancelled"].includes(executionStatus)) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshExecution(activeExecutionId);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeExecutionId, executionStatus, refreshExecution]);

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
    if (!session) {
      const nextSession = await startSession();
      if (!nextSession) return;
    }
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

  const executeSelectedMethod = async () => {
    if (!selectedMethodId || isExecutingMethod) return;
    if (draft && slugForMethodId(draft.title) !== selectedMethodId) {
      setMethodActionFeedback({
        tone: "error",
        text: `The visible draft is '${draft.title}', but Execute is pointed at saved Method '${selectedMethodId}'. Save the draft first or choose the matching saved Method.`,
      });
      return;
    }
    setIsExecutingMethod(true);
    setMethodActionFeedback({ tone: "info", text: "Starting Method execution..." });
    setExecutionStatus("starting");
    setExecutionNodes([]);
    setExecutionEvents([]);
    try {
      const executionId = await invoke<number>("execute_method", { id: selectedMethodId });
      setActiveExecutionId(executionId);
      setExecutionStatus("queued");
      await refreshExecution(executionId);
      setMethodActionFeedback({ tone: "success", text: `Started Method execution ${executionId}.` });
      addSystemMessage(`Started Method execution ${executionId}.`);
    } catch (err) {
      setExecutionStatus("failed");
      const message = `I could not execute Method '${selectedMethodId}': ${String(err)}`;
      setMethodActionFeedback({ tone: "error", text: message });
      addSystemMessage(message, "failed");
    } finally {
      setIsExecutingMethod(false);
    }
  };

  const saveCurrentDraftAsMethod = async () => {
    if (!draft || draft.readiness.blockers.length > 0 || isSavingMethod) return;
    setIsSavingMethod(true);
    setMethodActionFeedback({ tone: "info", text: "Saving Method..." });
    try {
      const summary = await invoke<MethodSummary>("save_current_method_draft");
      const savedMethods = await invoke<MethodSummary[]>("list_methods");
      const nextMethods = savedMethods.some((method) => method.id === summary.id)
        ? savedMethods
        : [summary, ...savedMethods];
      setMethods(nextMethods);
      setSelectedMethodId(summary.id);
      setMethodActionFeedback({ tone: "success", text: `Saved Method '${summary.title}'.` });
      addSystemMessage(`Saved Method '${summary.title}'.`);
    } catch (err) {
      const message = `I could not save the current Method draft: ${String(err)}`;
      setMethodActionFeedback({ tone: "error", text: message });
      addSystemMessage(message, "failed");
    } finally {
      setIsSavingMethod(false);
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
            <button type="submit" disabled={isSending || isConnecting}>
              {isSending ? "Sending" : "Send"}
            </button>
          </form>
        </section>

        <aside className="agent-visual-panel agent-graph-sidebar">
          <div className="method-draft-panel">
            <div className="method-draft-header">
              {draft ? (
                <div>
                  <span>{draft.lifecycle}</span>
                  <strong>{draft.title}</strong>
                </div>
              ) : (
                <div>
                  <span>Execution</span>
                  <strong>No Method draft exists yet.</strong>
                </div>
              )}
              <span>{draft ? `${draft.readiness.blockers.length} blockers` : `${methods.length} saved`}</span>
            </div>

            <section className="method-execution-panel" aria-label="Method execution">
              <div className="method-execution-controls">
                <select
                  value={selectedMethodId}
                  onChange={(event) => setSelectedMethodId(event.target.value)}
                  disabled={methods.length === 0 || isExecutingMethod}
                  aria-label="Saved Method"
                >
                  {methods.length === 0 ? (
                    <option value="">No saved Methods</option>
                  ) : (
                    methods.map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.title}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => void loadMethods()}
                  disabled={isExecutingMethod || isSavingMethod}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void saveCurrentDraftAsMethod()}
                  disabled={!draft || draft.readiness.blockers.length > 0 || isSavingMethod || isExecutingMethod}
                >
                  {isSavingMethod ? "Saving" : "Save Method"}
                </button>
                <button
                  type="button"
                  onClick={() => void executeSelectedMethod()}
                  disabled={!selectedMethodId || isExecutingMethod || isSavingMethod}
                >
                  {isExecutingMethod ? "Starting" : "Execute"}
                </button>
              </div>
              {methodActionFeedback && (
                <div className={`method-action-feedback ${methodActionFeedback.tone}`} role="status">
                  {methodActionFeedback.text}
                </div>
              )}
              <div className="method-execution-summary">
                <span>{activeExecutionId ? `Execution ${activeExecutionId}` : "No execution yet"}</span>
                <strong>{executionStatus}</strong>
              </div>
              {executionNodes.length > 0 && (
                <div className="method-execution-node-list" aria-label="Execution node status">
                  {executionNodes.map((node) => (
                    <div key={node.id}>
                      <span>
                        {node.nodeId}
                        {node.errorMessage && <em>{node.errorMessage}</em>}
                      </span>
                      <strong className={`status-${node.status}`}>{node.status}</strong>
                    </div>
                  ))}
                </div>
              )}
              {executionEvents.length > 0 && (
                <div className="method-execution-events" aria-label="Execution events">
                  {executionEvents.slice(-4).map((event) => (
                    <div key={event.id}>
                      <span>
                        {event.nodeId ?? "execution"}
                        {eventDetail(event) && <em>{eventDetail(event)}</em>}
                      </span>
                      <code>{event.eventType}</code>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {draft ? (
              <MethodGraph draft={draft} executionNodes={executionNodes} />
            ) : (
              <div className="agent-empty-visual">Saved Methods can be executed from the controls above.</div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
