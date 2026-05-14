import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { emitAppEvent } from "../../appEvents";
import type {
  CodexAppServerEvent,
  CodexAppServerSession,
  CodexTurnSummary,
  DesignAgentConfig,
  MethodDocument,
  MethodExecutionNodeSummary,
  MethodExecutionSummary,
} from "../../database";
import MethodGraph from "../method-graph/MethodGraph";
import { ChatPanelView } from "./ChatPanelView";
import type { ChatMessage, ChatSession } from "./agentTypes";
import {
  METHOD_DRAFT_MUTATION_TOOLS,
  NEW_CHAT_DRAFT_KEY,
  agentInputWithContext,
  appendDelta,
  createChatSession,
  dispatchAgentFileChange,
  fallbackChatTitle,
  isDesignAgentConfig,
  isMethodDocument,
  isMissingProjectError,
  loadPersistedChatSessions,
  normalizeChatSessions,
  shouldPersistProjectConversations,
  toolTraceText,
  upsertAssistantMessage,
  upsertTraceMessage,
  userFacingError,
} from "./chatModel";

export { shouldPersistProjectConversations } from "./chatModel";

interface AgentWorkspaceProps {
  initialChatId?: string;
}

interface MethodWorkspaceContextValue {
  renderChatPanel: (chatId?: string | null) => ReactNode;
  renderDraftGraphPanel: () => ReactNode;
  renderFullWorkspace: () => ReactNode;
  renderExecutionGraphPanel: (executionId?: string | number | null) => ReactNode;
}

const MethodWorkspaceContext = createContext<MethodWorkspaceContextValue | null>(null);

function useMethodWorkspace() {
  const value = useContext(MethodWorkspaceContext);
  if (!value) {
    throw new Error("Method workspace panels must be rendered inside MethodWorkspaceProvider");
  }
  return value;
}

export function ChatPanel({ chatId }: { chatId?: string | null }) {
  const generatedChatIdRef = useRef<string | null>(null);
  if (!chatId && !generatedChatIdRef.current) {
    generatedChatIdRef.current = createChatSession().id;
  }
  return <>{useMethodWorkspace().renderChatPanel(chatId ?? generatedChatIdRef.current)}</>;
}

export function DraftMethodGraphPanel() {
  return <>{useMethodWorkspace().renderDraftGraphPanel()}</>;
}

export function MethodExecutionGraphPanel({ executionId }: { executionId?: string | number | null }) {
  return <>{useMethodWorkspace().renderExecutionGraphPanel(executionId)}</>;
}

export function MethodWorkspaceProvider({
  children,
  initialChatId,
}: {
  children?: ReactNode;
  initialChatId?: string;
}) {
  const hasProjectRootRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(loadPersistedChatSessions);
  const persistedConversationCountRef = useRef(0);
  const [chatPersistenceReady, setChatPersistenceReady] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(() => (
    chatSessions.find((chat) => chat.id === initialChatId)?.id
      ?? chatSessions[0]?.id
      ?? null
  ));
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const pendingTurnChatIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<CodexAppServerSession | null>(null);
  const [activeTurn, setActiveTurn] = useState<CodexTurnSummary | null>(null);
  const [draft, setDraft] = useState<MethodDocument | null>(null);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [agentConfig, setAgentConfig] = useState<DesignAgentConfig | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendingChatId, setSendingChatId] = useState<string | null>(null);
  const activeMessages = useMemo(() => (
    chatSessions.find((chat) => chat.id === activeChatId)?.messages
      ?? []
  ), [activeChatId, chatSessions]);
  const activeDraftKey = activeChatId ?? NEW_CHAT_DRAFT_KEY;
  const activeInput = composerDrafts[activeDraftKey] ?? "";

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [activeInput]);

  const setComposerInput = useCallback((chatId: string | null | undefined, value: string) => {
    const key = chatId ?? NEW_CHAT_DRAFT_KEY;
    setComposerDrafts((current) => current[key] === value ? current : { ...current, [key]: value });
  }, []);

  const clearComposerInput = useCallback((chatId: string | null | undefined) => {
    const key = chatId ?? NEW_CHAT_DRAFT_KEY;
    setComposerDrafts((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const applyChatSessions = useCallback((sessions: ChatSession[]) => {
    const nextSessions = sessions;
    const nextActiveChat =
      nextSessions.find((chat) => chat.id === initialChatId)
      ?? nextSessions[0]
      ?? null;
    activeChatIdRef.current = nextActiveChat?.id ?? null;
    setChatSessions(nextSessions);
    setActiveChatId(nextActiveChat?.id ?? null);
  }, [initialChatId]);

  const loadProjectChatSessions = useCallback(async () => {
    try {
      const value = await invoke<unknown | null>("load_project_conversations");
      if (value !== null && value !== undefined) {
        const sessions = normalizeChatSessions(value);
        persistedConversationCountRef.current = sessions.filter((chat) => chat.messages.length > 0).length;
        applyChatSessions(sessions);
      } else {
        persistedConversationCountRef.current = 0;
        applyChatSessions([]);
      }
      setChatPersistenceReady(true);
    } catch {
      setChatPersistenceReady(false);
    }
  }, [applyChatSessions]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const loadIfProjectOpen = async () => {
      try {
        const root = await invoke<string | null>("get_root_path");
        if (!cancelled && root) await loadProjectChatSessions();
      } catch {
        if (!cancelled) setChatPersistenceReady(false);
      }
    };
    void loadIfProjectOpen();
    listen<string>("project-opened", () => {
      if (!cancelled) void loadProjectChatSessions();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        if (!cancelled) setChatPersistenceReady(false);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadProjectChatSessions]);

  useEffect(() => {
    if (!chatPersistenceReady) return;
    const conversations = chatSessions.filter((chat) => chat.messages.length > 0);
    if (!shouldPersistProjectConversations(
      chatPersistenceReady,
      conversations.length,
      persistedConversationCountRef.current,
    )) return;
    void invoke("save_project_conversations", { conversations })
      .then(() => {
        persistedConversationCountRef.current = conversations.length;
        emitAppEvent("conversationsUpdated");
      });
  }, [chatPersistenceReady, chatSessions]);

  useEffect(() => {
    let cancelled = false;
    invoke<DesignAgentConfig | null>("get_design_agent_config")
      .then((config) => {
        if (!cancelled && isDesignAgentConfig(config)) setAgentConfig(config);
      })
      .catch(() => {
        if (!cancelled) {
          setAgentConfig({ model: "unknown", reasoningSummary: "unknown", maxToolLoops: 0 });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateChatMessages = useCallback((
    chatId: string,
    updater: (current: ChatMessage[]) => ChatMessage[],
  ) => {
    setChatSessions((current) => {
      let found = false;
      const next = current.map((chat) => {
        if (chat.id !== chatId) return chat;
        found = true;
        const nextMessages = updater(chat.messages);
        return {
          ...chat,
          title: fallbackChatTitle(nextMessages),
          updatedAt: new Date().toISOString(),
          messages: nextMessages,
        };
      });
      if (found) return next;
      const nextMessages = updater([]);
      return [createChatSession(nextMessages, chatId), ...current];
    });
  }, []);

  const addSystemMessage = useCallback((text: string, status: ChatMessage["status"] = "completed") => {
    const targetChatId = activeChatIdRef.current ?? createChatSession().id;
    if (!activeChatIdRef.current) {
      activeChatIdRef.current = targetChatId;
      setActiveChatId(targetChatId);
    }
    updateChatMessages(targetChatId, (current) => [
      ...current,
      { id: `system-${Date.now()}-${current.length}`, role: "system", text, status },
    ]);
  }, [updateChatMessages]);

  const selectChat = useCallback((chatId: string) => {
    const chat = chatSessions.find((candidate) => candidate.id === chatId);
    if (!chat || chat.id === activeChatIdRef.current) return;
    activeChatIdRef.current = chat.id;
    setActiveChatId(chat.id);
  }, [chatSessions]);

  const startNewChat = useCallback(() => {
    const chat = createChatSession();
    activeChatIdRef.current = chat.id;
    setChatSessions((current) => [chat, ...current]);
    setActiveChatId(chat.id);
  }, []);

  const startSession = useCallback(async (options?: { silentMissingProject?: boolean }) => {
    setIsConnecting(true);
    try {
      const nextSession = await invoke<CodexAppServerSession>("start_design_session");
      setSession(nextSession);
      return nextSession;
    } catch (err) {
      if (!options?.silentMissingProject || !isMissingProjectError(err)) {
        addSystemMessage(userFacingError(err), "failed");
      }
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [addSystemMessage]);

  const loadCurrentDraft = useCallback(async (options?: { silentMissingProject?: boolean }) => {
    try {
      const currentDraft = await invoke<MethodDocument | null>("get_current_method_draft");
      setDraft(isMethodDocument(currentDraft) ? currentDraft : null);
    } catch (err) {
      if (!options?.silentMissingProject || !isMissingProjectError(err)) {
        addSystemMessage(`I could not load the current Method draft: ${String(err)}`, "failed");
      }
    }
  }, [addSystemMessage]);

  useEffect(() => {
    let cancelled = false;
    const connectIfProjectOpen = async () => {
      try {
        const root = await invoke<string | null>("get_root_path");
        if (cancelled || !root) return;
        hasProjectRootRef.current = true;
        void startSession({ silentMissingProject: true });
        void loadCurrentDraft({ silentMissingProject: true });
      } catch (err) {
        if (!cancelled && !isMissingProjectError(err)) {
          addSystemMessage(`I could not check the current project folder: ${String(err)}`, "failed");
        }
      }
    };
    void connectIfProjectOpen();
    return () => {
      cancelled = true;
    };
  }, [addSystemMessage, loadCurrentDraft, startSession]);

  useEffect(() => {
    void loadCurrentDraft({ silentMissingProject: true });
  }, [loadCurrentDraft]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("project-opened", () => {
      if (cancelled) return;
      hasProjectRootRef.current = true;
      void startSession({ silentMissingProject: true });
      void loadCurrentDraft({ silentMissingProject: true });
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
  }, [addSystemMessage, loadCurrentDraft, startSession]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<MethodDocument | null>("method-draft-updated", (event) => {
      if (!cancelled) setDraft(isMethodDocument(event.payload) ? event.payload : null);
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
      const targetChatId = pendingTurnChatIdRef.current ?? activeChatIdRef.current ?? createChatSession().id;
      if (!activeChatIdRef.current) {
        activeChatIdRef.current = targetChatId;
        setActiveChatId(targetChatId);
      }
      if (payload.eventType === "item/agentMessage/delta" && payload.textDelta) {
        updateChatMessages(targetChatId, (current) =>
          appendDelta(
            current,
            payload.itemId ?? `assistant-${payload.turnId ?? Date.now()}`,
            payload.textDelta ?? "",
          ),
        );
      }
      if (payload.eventType === "item/completed" && payload.messageText) {
        updateChatMessages(targetChatId, (current) =>
          upsertAssistantMessage(
            current,
            payload.itemId ?? `assistant-${payload.turnId ?? Date.now()}`,
            payload.messageText ?? "",
          ),
        );
      }
      if (payload.eventType.includes("reasoningSummary") && payload.messageText) {
        updateChatMessages(targetChatId, (current) =>
          upsertTraceMessage(
            current,
            payload.itemId ?? `reasoning-${payload.turnId ?? Date.now()}`,
            payload.messageText ?? "",
            payload.status === "failed" ? "failed" : "completed",
            "reasoning",
          ),
        );
      }
      if (payload.eventType.startsWith("item/toolCall/")) {
        updateChatMessages(targetChatId, (current) =>
          upsertTraceMessage(
            current,
            payload.itemId ?? `tool-${payload.turnId ?? Date.now()}-${payload.toolName ?? "unknown"}`,
            toolTraceText(payload),
            payload.status === "failed" ? "failed" : payload.status === "started" ? "streaming" : "completed",
            "tool",
            {
              toolName: payload.toolName,
              toolArguments: payload.toolArguments,
              toolOutput: payload.toolOutput,
              outputSummary: payload.outputSummary,
              durationMs: payload.durationMs,
            },
          ),
        );
        if (payload.eventType === "item/toolCall/completed") {
          dispatchAgentFileChange(payload.toolName);
          if (payload.toolName && METHOD_DRAFT_MUTATION_TOOLS.has(payload.toolName)) {
            void loadCurrentDraft({ silentMissingProject: true });
          }
        }
      }
      if (payload.eventType === "turn/completed") {
        setIsSending(false);
        setSendingChatId(null);
        setActiveTurn(null);
        pendingTurnChatIdRef.current = null;
        if (payload.status === "failed") {
          updateChatMessages(targetChatId, (current) => [
            ...current,
            {
              id: `system-${Date.now()}-${current.length}`,
              role: "system",
              text: payload.errorMessage ?? "The design turn failed.",
              status: "failed",
            },
          ]);
        }
      }
      if (payload.eventType.startsWith("connection/") && payload.errorMessage) {
        setIsSending(false);
        setSendingChatId(null);
        setActiveTurn(null);
        pendingTurnChatIdRef.current = null;
        updateChatMessages(targetChatId, (current) => [
          ...current,
          {
            id: `system-${Date.now()}-${current.length}`,
            role: "system",
            text: userFacingError(payload.errorMessage),
            status: "failed",
          },
        ]);
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
  }, [addSystemMessage, loadCurrentDraft, updateChatMessages]);

  const submitChatMessage = useCallback(async (
    targetChatId: string | null,
    baseMessages: ChatMessage[],
    rawText: string,
  ) => {
    const text = rawText.trim();
    if (!text || isSending) return;
    if (!session) {
      const nextSession = await startSession();
      if (!nextSession) return;
    }
    setIsSending(true);
    const chat = targetChatId
      ? chatSessions.find((candidate) => candidate.id === targetChatId)
      : null;
    const submittingChatId = targetChatId ?? activeChatIdRef.current ?? createChatSession().id;
    const contextMessages = targetChatId ? (chat?.messages ?? baseMessages) : baseMessages;

    if (activeChatIdRef.current !== submittingChatId) {
      activeChatIdRef.current = submittingChatId;
      setActiveChatId(submittingChatId);
    }
    pendingTurnChatIdRef.current = submittingChatId;
    setSendingChatId(submittingChatId);
    const messageForAgent = agentInputWithContext(contextMessages, text);
    updateChatMessages(submittingChatId, (current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", text, status: "completed" },
      { id: `pending-${Date.now()}`, role: "system", text: "Thinking", status: "pending" },
    ]);
    try {
      const turn = await invoke<CodexTurnSummary>("send_design_chat_message", { input: { message: messageForAgent } });
      setActiveTurn(turn);
      setSession({ threadId: turn.threadId });
      updateChatMessages(submittingChatId, (current) => current.filter((message) => message.status !== "pending"));
    } catch (err) {
      setIsSending(false);
      setSendingChatId(null);
      pendingTurnChatIdRef.current = null;
      updateChatMessages(submittingChatId, (current) => [
        ...current.filter((message) => message.status !== "pending"),
        { id: `send-error-${Date.now()}`, role: "system", text: userFacingError(err), status: "failed" },
      ]);
    }
  }, [chatSessions, isSending, session, startSession, updateChatMessages]);

  const handleSubmit = useCallback(async () => {
    const text = activeInput.trim();
    if (!text || isSending) return;
    clearComposerInput(activeChatIdRef.current);
    await submitChatMessage(activeChatIdRef.current, activeMessages, text);
  }, [activeInput, activeMessages, clearComposerInput, isSending, submitChatMessage]);

  const modelConfigLabel = agentConfig
    ? `${agentConfig.model} · reasoning ${agentConfig.reasoningSummary}${
      agentConfig.maxToolLoops ? ` · ${agentConfig.maxToolLoops} tool loops` : ""
    }`
    : "loading model config";

  const renderActiveChatPanel = useCallback(() => (
    <ChatPanelView
      messages={activeMessages}
      input={activeInput}
      setInput={(value) => setComposerInput(activeChatIdRef.current, value)}
      onSubmit={() => void handleSubmit()}
      isSending={isSending && sendingChatId === activeChatId}
      activeTurn={sendingChatId === activeChatId ? activeTurn : null}
      isSendDisabled={isSending}
      isConnecting={isConnecting}
      modelConfigLabel={modelConfigLabel}
      inputRef={inputRef}
    />
  ), [
    activeChatId,
    activeInput,
    activeMessages,
    activeTurn,
    handleSubmit,
    isConnecting,
    isSending,
    modelConfigLabel,
    sendingChatId,
    setComposerInput,
  ]);

  const renderSavedChatPanel = useCallback((chat: ChatSession) => {
    const input = composerDrafts[chat.id] ?? "";
    return (
      <ChatPanelView
        messages={chat.messages}
        input={input}
        setInput={(value) => setComposerInput(chat.id, value)}
        onSubmit={() => {
          const text = input.trim();
          if (!text) return;
          clearComposerInput(chat.id);
          void submitChatMessage(chat.id, chat.messages, text);
        }}
        isSending={isSending && sendingChatId === chat.id}
        activeTurn={sendingChatId === chat.id ? activeTurn : null}
        isSendDisabled={isSending}
        isConnecting={isConnecting}
        modelConfigLabel={modelConfigLabel}
      />
    );
  }, [
    activeTurn,
    clearComposerInput,
    composerDrafts,
    isConnecting,
    isSending,
    modelConfigLabel,
    sendingChatId,
    setComposerInput,
    submitChatMessage,
  ]);

  const renderEmptyChatPanel = useCallback((chatId: string) => {
    const input = composerDrafts[chatId] ?? "";
    return (
      <ChatPanelView
        messages={[]}
        input={input}
        setInput={(value) => setComposerInput(chatId, value)}
        onSubmit={() => {
          const text = input.trim();
          if (!text) return;
          clearComposerInput(chatId);
          void submitChatMessage(chatId, [], text);
        }}
        isSending={isSending && sendingChatId === chatId}
        activeTurn={sendingChatId === chatId ? activeTurn : null}
        isSendDisabled={isSending}
        isConnecting={isConnecting}
        modelConfigLabel={modelConfigLabel}
      />
    );
  }, [
    activeTurn,
    clearComposerInput,
    composerDrafts,
    isConnecting,
    isSending,
    modelConfigLabel,
    sendingChatId,
    setComposerInput,
    submitChatMessage,
  ]);

  const chatSidebar = useMemo(() => (
    <aside className="agent-chats-sidebar">
        <header className="agent-chats-header">
          <h2>Chats</h2>
          <button type="button" className="btn-primary btn-small" onClick={startNewChat}>
            + New
          </button>
        </header>

        <ul className="agent-chat-list" aria-label="Planning chats">
          {chatSessions.map((chat) => (
            <li
              key={chat.id}
              className={`agent-chat-list-item${activeChatId === chat.id ? " selected" : ""}`}
              onClick={() => selectChat(chat.id)}
            >
              <div className="agent-chat-list-title">{chat.title}</div>
              <div className="agent-chat-list-meta">
                {chat.messages.filter((message) => message.role === "user").length} message
                {chat.messages.filter((message) => message.role === "user").length === 1 ? "" : "s"}
              </div>
            </li>
          ))}
        </ul>
      </aside>
  ), [activeChatId, chatSessions, selectChat, startNewChat]);

  const renderChatPanel = useCallback((chatId?: string | null) => {
    if (!chatId) {
      return renderActiveChatPanel();
    }
    const chat = chatSessions.find((candidate) => candidate.id === chatId);
    if (!chat) {
      return renderEmptyChatPanel(chatId);
    }
    return renderSavedChatPanel(chat);
  }, [chatSessions, renderActiveChatPanel, renderEmptyChatPanel, renderSavedChatPanel]);

  const graphPanel = useMemo(() => (
    <div className="agent-visual-panel agent-graph-sidebar graph-only">
      {draft ? (
        <MethodGraph draft={draft} />
      ) : (
        <div className="agent-empty-visual">No Method draft yet. Start in Chat to create one.</div>
      )}
    </div>
  ), [draft]);

  const renderDraftGraphPanel = useCallback(() => (
    <div className="agent-chat-workspace panel-embedded">{graphPanel}</div>
  ), [graphPanel]);

  const renderFullWorkspace = useCallback(() => (
    <div className="agent-chat-workspace">
      {chatSidebar}

      <PanelGroup
        id="agent-chat-main"
        className="agent-chat-main"
        direction="horizontal"
        keyboardResizeBy={4}
      >
        <Panel
          id="agent-chat-panel"
          order={1}
          defaultSize={62}
          minSize={35}
          className="agent-chat-panel"
        >
          {renderActiveChatPanel()}
        </Panel>

        <PanelResizeHandle
          id="agent-graph-resize-handle"
          className="agent-pane-resizer"
          aria-label="Resize Method graph panel"
        />

        <Panel
          id="agent-graph-panel"
          order={2}
          defaultSize={38}
          minSize={18}
          className="agent-visual-panel agent-graph-sidebar"
        >
          {graphPanel}
        </Panel>
      </PanelGroup>
    </div>
  ), [chatSidebar, graphPanel, renderActiveChatPanel]);

  const renderExecutionGraphPanel = useCallback((executionId?: string | number | null) => (
    <ExecutionGraphPanelView executionId={executionId} />
  ), []);

  const contextValue = useMemo<MethodWorkspaceContextValue>(() => ({
    renderChatPanel,
    renderDraftGraphPanel,
    renderFullWorkspace,
    renderExecutionGraphPanel,
  }), [renderChatPanel, renderDraftGraphPanel, renderExecutionGraphPanel, renderFullWorkspace]);

  return (
    <MethodWorkspaceContext.Provider value={contextValue}>
      {children ?? renderFullWorkspace()}
    </MethodWorkspaceContext.Provider>
  );
}

export default function AgentWorkspace({ initialChatId }: AgentWorkspaceProps) {
  return <MethodWorkspaceProvider initialChatId={initialChatId} />;
}

function ExecutionGraphPanelView({ executionId }: { executionId?: string | number | null }) {
  const numericExecutionId = Number(executionId);
  const [method, setMethod] = useState<MethodDocument | null>(null);
  const [nodes, setNodes] = useState<MethodExecutionNodeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadExecution = useCallback(async () => {
    if (!Number.isFinite(numericExecutionId)) {
      setError("Execution id is missing.");
      return;
    }
    try {
      const executions = await invoke<MethodExecutionSummary[]>("list_method_executions", { methodId: null });
      const execution = executions.find((candidate) => candidate.id === numericExecutionId);
      if (!execution) throw new Error(`Method execution ${numericExecutionId} was not found.`);
      const [frozenMethod, executionNodes] = await Promise.all([
        invoke<MethodDocument>("get_execution_method", { executionId: numericExecutionId }),
        invoke<MethodExecutionNodeSummary[]>("get_method_execution_nodes", { executionId: numericExecutionId }),
      ]);
      setMethod(frozenMethod);
      setNodes(executionNodes);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [numericExecutionId]);

  useEffect(() => {
    void loadExecution();
  }, [loadExecution]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ executionId: number }>("method-execution-event", (event) => {
      if (!cancelled && event.payload.executionId === numericExecutionId) {
        void loadExecution();
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadExecution, numericExecutionId]);

  if (error) {
    return <div className="agent-empty-visual">{error}</div>;
  }
  if (!method) {
    return <div className="agent-empty-visual">Loading Method execution...</div>;
  }
  return (
    <div className="agent-chat-workspace panel-embedded">
      <div className="agent-visual-panel agent-graph-sidebar graph-only">
        <MethodGraph draft={method} executionNodes={nodes} />
      </div>
    </div>
  );
}
