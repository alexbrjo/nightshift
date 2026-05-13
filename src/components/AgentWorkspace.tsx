import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type {
  CodexAppServerEvent,
  CodexAppServerSession,
  CodexTurnSummary,
  DesignAgentConfig,
  MethodDocument,
  MethodExecutionNodeSummary,
  MethodExecutionSummary,
  MethodSummary,
} from "../database";
import MethodGraph from "./MethodGraph";

interface ChatMessage {
  id: string;
  role: "assistant" | "user" | "system" | "trace";
  text: string;
  status?: "pending" | "streaming" | "completed" | "failed";
  traceKind?: "reasoning" | "tool";
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  outputSummary?: string;
  durationMs?: number;
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

interface ToolTraceGroup {
  id: string;
  role: "toolTraceGroup";
  messages: ChatMessage[];
}

type ChatItem = ChatMessage | ToolTraceGroup;

const ALLOWED_MARKDOWN_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safeHref = safeMarkdownHref(href);
    return safeHref ? (
      <a href={safeHref} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
};

const RAW_SCRIPT_OR_STYLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const CHAT_STORAGE_KEY = "nightshift-agent-chats:v1";
const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: "Describe the Method you want to design. I can help shape the workflow and keep the draft state visible beside chat.",
  status: "completed",
};

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

function upsertTraceMessage(
  messages: ChatMessage[],
  itemId: string,
  text: string,
  status: ChatMessage["status"] = "completed",
  traceKind: ChatMessage["traceKind"] = "reasoning",
  metadata: Partial<ChatMessage> = {},
): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === itemId);
  const nextMessage: ChatMessage = { id: itemId, role: "trace", text, status, traceKind, ...metadata };
  if (index === -1) return [...messages, nextMessage];
  return messages.map((message, currentIndex) =>
    currentIndex === index ? { ...message, text, status, traceKind, ...metadata } : message,
  );
}

function formatDuration(durationMs?: number) {
  if (durationMs === undefined || durationMs === null) return null;
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

function toolTraceText(payload: CodexAppServerEvent): string {
  const name = payload.toolName ?? "Method tool";
  if (payload.status === "started") return `Calling ${name}`;
  const parts = [
    `${name} ${payload.status === "failed" ? "failed" : "completed"}`,
    formatDuration(payload.durationMs),
    payload.outputSummary,
  ].filter(Boolean);
  const text = parts.join(" - ");
  return payload.status === "failed" && payload.errorMessage ? `${text}: ${payload.errorMessage}` : text;
}

function prettyJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = JSON.stringify(value, null, 2);
  return text.length > 5000 ? `${text.slice(0, 5000)}\n... truncated` : text;
}

function safeMarkdownHref(href?: string) {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return trimmed;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function markdownSource(text: string) {
  return text.replace(RAW_SCRIPT_OR_STYLE_BLOCK, "");
}

function AgentMessageBody({ message }: { message: ChatMessage }) {
  if (message.role === "user") return <>{message.text}</>;
  if (message.status === "pending" && message.text === "Thinking") {
    return (
      <span className="agent-thinking-indicator">
        Thinking<span className="agent-thinking-dots" aria-hidden="true" />
      </span>
    );
  }
  return (
    <div className="agent-message-rendered">
      <ReactMarkdown
        allowedElements={ALLOWED_MARKDOWN_ELEMENTS}
        components={MARKDOWN_COMPONENTS}
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {markdownSource(message.text)}
      </ReactMarkdown>
    </div>
  );
}

function groupToolTraceMessages(messages: ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  let pendingTools: ChatMessage[] = [];

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    items.push({
      id: `tool-group-${pendingTools[0].id}`,
      role: "toolTraceGroup",
      messages: pendingTools,
    });
    pendingTools = [];
  };

  for (const message of messages) {
    if (message.role === "trace" && message.traceKind === "tool") {
      pendingTools.push(message);
    } else {
      flushTools();
      items.push(message);
    }
  }
  flushTools();

  return items;
}

function userFacingError(err: unknown) {
  return `I could not reach the design agent: ${String(err)}`;
}

function fallbackChatTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.text.trim());
  if (!firstUserMessage) return "New planning chat";
  const normalized = firstUserMessage.text.trim().replace(/\s+/g, " ");
  return normalized.length > 42 ? `${normalized.slice(0, 39)}...` : normalized;
}

function createChatSession(messages: ChatMessage[] = [{ ...WELCOME_MESSAGE }]): ChatSession {
  const now = new Date().toISOString();
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: fallbackChatTitle(messages),
    createdAt: now,
    updatedAt: now,
    messages,
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && "id" in value
      && "role" in value
      && "text" in value,
  );
}

function isDesignAgentConfig(value: unknown): value is DesignAgentConfig {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && "model" in value
      && "reasoningSummary" in value
      && "maxToolLoops" in value,
  );
}

function normalizeChatSessions(value: unknown): ChatSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((chat): chat is ChatSession => {
      if (!chat || typeof chat !== "object" || Array.isArray(chat)) return false;
      const candidate = chat as Partial<ChatSession>;
      return Boolean(
        typeof candidate.id === "string"
          && typeof candidate.title === "string"
          && typeof candidate.createdAt === "string"
          && typeof candidate.updatedAt === "string"
          && Array.isArray(candidate.messages)
          && candidate.messages.every(isChatMessage),
      );
    })
    .map((chat) => ({
      ...chat,
      messages: chat.messages.length > 0 ? chat.messages : [{ ...WELCOME_MESSAGE }],
    }));
}

function loadPersistedChatSessions(): ChatSession[] {
  if (typeof window === "undefined") return [createChatSession()];
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    const sessions = raw ? normalizeChatSessions(JSON.parse(raw)) : [];
    return sessions.length > 0 ? sessions : [createChatSession()];
  } catch {
    return [createChatSession()];
  }
}

function visibleTranscript(messages: ChatMessage[]) {
  return messages
    .filter((message) =>
      message.status !== "pending"
      && message.role !== "trace"
      && message.id !== WELCOME_MESSAGE.id
      && message.text.trim(),
    )
    .slice(-12)
    .map((message) => `${message.role}: ${message.text.trim()}`)
    .join("\n\n");
}

function agentInputWithContext(messages: ChatMessage[], nextMessage: string) {
  const transcript = visibleTranscript(messages);
  if (!transcript) return nextMessage;
  return [
    "Use this existing planning chat context before answering or changing the Method draft:",
    transcript,
    "New user message:",
    nextMessage,
  ].join("\n\n");
}

function estimateTokenCount(text: string) {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function formatTokenCount(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : String(count);
}

function isMissingProjectError(err: unknown) {
  const message = String(err);
  return message.includes("No project folder is open")
    || message.includes("Open a project folder before starting");
}

function isMethodDocument(value: unknown): value is MethodDocument {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && "id" in value
      && "workflow" in value,
  );
}

function derivedDraftReadiness(draft: MethodDocument | null) {
  if (!draft) return { status: "drafting", blockers: [] };
  const blockers: string[] = [];
  if (!draft.title.trim() || draft.title === "Untitled Method") blockers.push("title");
  if (!draft.objective.trim()) blockers.push("objective");
  if (draft.workflow.nodes.length === 0) blockers.push("nodes");
  for (const resource of draft.workflow.nodes.filter((node) => node.type === "resource")) {
    if (!resource.path && !resource.reference) blockers.push(resource.id);
  }
  return { status: blockers.length ? "drafting" : "ready", blockers };
}

export default function AgentWorkspace() {
  const hasProjectRootRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(loadPersistedChatSessions);
  const [activeChatId, setActiveChatId] = useState(() => chatSessions[0]?.id ?? createChatSession().id);
  const activeChatIdRef = useRef(activeChatId);
  const pendingTurnChatIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<CodexAppServerSession | null>(null);
  const [activeTurn, setActiveTurn] = useState<CodexTurnSummary | null>(null);
  const [draft, setDraft] = useState<MethodDocument | null>(null);
  const [methods, setMethods] = useState<MethodSummary[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [activeExecutionId, setActiveExecutionId] = useState<number | null>(null);
  const [executionNodes, setExecutionNodes] = useState<MethodExecutionNodeSummary[]>([]);
  const [executionStatus, setExecutionStatus] = useState<string>("idle");
  const [isSavingMethod, setIsSavingMethod] = useState(false);
  const [isExecutingMethod, setIsExecutingMethod] = useState(false);
  const [methodActionFeedback, setMethodActionFeedback] = useState<{
    tone: "info" | "success" | "error";
    text: string;
  } | null>(null);
  const [input, setInput] = useState("");
  const [agentConfig, setAgentConfig] = useState<DesignAgentConfig | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatSessions[0]?.messages ?? [{ ...WELCOME_MESSAGE }]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatSessions));
  }, [chatSessions]);

  useEffect(() => {
    setChatSessions((current) => {
      let changed = false;
      const next = current.map((chat) => {
        if (chat.id !== activeChatId) return chat;
        const title = fallbackChatTitle(messages);
        const updated = { ...chat, title, updatedAt: new Date().toISOString(), messages };
        changed = true;
        return updated;
      });
      return changed ? next : current;
    });
  }, [activeChatId, messages]);

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

  const addSystemMessage = useCallback((text: string, status: ChatMessage["status"] = "completed") => {
    setMessages((current) => [
      ...current,
      { id: `system-${Date.now()}-${current.length}`, role: "system", text, status },
    ]);
  }, []);

  const updateChatMessages = useCallback((
    chatId: string,
    updater: (current: ChatMessage[]) => ChatMessage[],
  ) => {
    if (activeChatIdRef.current === chatId) {
      setMessages(updater);
    }
    setChatSessions((current) =>
      current.map((chat) => {
        if (chat.id !== chatId) return chat;
        const nextMessages = updater(chat.messages);
        return {
          ...chat,
          title: fallbackChatTitle(nextMessages),
          updatedAt: new Date().toISOString(),
          messages: nextMessages,
        };
      }),
    );
  }, []);

  const selectChat = useCallback((chatId: string) => {
    const chat = chatSessions.find((candidate) => candidate.id === chatId);
    if (!chat || chat.id === activeChatIdRef.current) return;
    activeChatIdRef.current = chat.id;
    setInput("");
    setMessages(chat.messages);
    setActiveChatId(chat.id);
  }, [chatSessions]);

  const startNewChat = useCallback(() => {
    const chat = createChatSession();
    activeChatIdRef.current = chat.id;
    setChatSessions((current) => [chat, ...current]);
    setInput("");
    setMessages(chat.messages);
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

  useEffect(() => {
    let cancelled = false;
    const connectIfProjectOpen = async () => {
      try {
        const root = await invoke<string | null>("get_root_path");
        if (cancelled || !root) return;
        hasProjectRootRef.current = true;
        void startSession({ silentMissingProject: true });
        void loadCurrentDraft({ silentMissingProject: true });
        void loadMethods();
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
  }, [addSystemMessage, loadCurrentDraft, loadMethods, startSession]);

  const refreshExecution = useCallback(
    async (executionId: number) => {
      try {
        const [executions, nodes] = await Promise.all([
          invoke<MethodExecutionSummary[]>("list_method_executions", { methodId: selectedMethodId || null }),
          invoke<MethodExecutionNodeSummary[]>("get_method_execution_nodes", { executionId }),
        ]);
        const currentExecution = executions.find((execution) => execution.id === executionId);
        setExecutionStatus(currentExecution?.status ?? "running");
        setExecutionNodes(nodes);
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
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeExecutionId, executionStatus, refreshExecution]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<CodexAppServerEvent>("codex-app-server-event", (event) => {
      if (cancelled) return;
      const payload = event.payload;
      const targetChatId = pendingTurnChatIdRef.current ?? activeChatIdRef.current;
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
      }
      if (payload.eventType === "turn/completed") {
        setIsSending(false);
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
  }, [addSystemMessage, updateChatMessages]);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    if (!session) {
      const nextSession = await startSession();
      if (!nextSession) return;
    }
    setInput("");
    setIsSending(true);
    const submittingChatId = activeChatIdRef.current;
    pendingTurnChatIdRef.current = submittingChatId;
    const messageForAgent = agentInputWithContext(messages, text);
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
      pendingTurnChatIdRef.current = null;
      updateChatMessages(submittingChatId, (current) => [
        ...current.filter((message) => message.status !== "pending"),
        { id: `send-error-${Date.now()}`, role: "system", text: userFacingError(err), status: "failed" },
      ]);
    }
  };

  const executeSelectedMethod = async () => {
    if (!selectedMethodId || isExecutingMethod) return;
    if (draft && draft.id !== selectedMethodId) {
      setMethodActionFeedback({
        tone: "error",
        text: `The visible draft is '${draft.title}', but Execute is pointed at saved Method '${selectedMethodId}'. Save the draft first or choose the matching saved Method.`,
      });
      return;
    }
    setIsExecutingMethod(true);
    setMethodActionFeedback(null);
    setExecutionStatus("starting");
    setExecutionNodes([]);
    try {
      const executionId = await invoke<number>("execute_method", { id: selectedMethodId });
      setActiveExecutionId(executionId);
      setExecutionStatus("queued");
      await refreshExecution(executionId);
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
    if (!draft || derivedDraftReadiness(draft).blockers.length > 0 || isSavingMethod) return;
    setIsSavingMethod(true);
    setMethodActionFeedback(null);
    try {
      const summary = await invoke<MethodSummary>("save_current_method_draft");
      const savedMethods = await invoke<MethodSummary[]>("list_methods");
      const nextMethods = savedMethods.some((method) => method.id === summary.id)
        ? savedMethods
        : [summary, ...savedMethods];
      setMethods(nextMethods);
      setSelectedMethodId(summary.id);
    } catch (err) {
      const message = `I could not save the current Method draft: ${String(err)}`;
      setMethodActionFeedback({ tone: "error", text: message });
      addSystemMessage(message, "failed");
    } finally {
      setIsSavingMethod(false);
    }
  };

  const chatItems = groupToolTraceMessages(messages);
  const contextTokenEstimate = estimateTokenCount(agentInputWithContext(messages, input.trim()));
  const modelConfigLabel = agentConfig
    ? `${agentConfig.model} · reasoning ${agentConfig.reasoningSummary}${
      agentConfig.maxToolLoops ? ` · ${agentConfig.maxToolLoops} tool loops` : ""
    }`
    : "loading model config";

  return (
    <div className="agent-chat-workspace">
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
          <div className="agent-chat-scroll">
            {chatItems.map((item) => {
              if (item.role === "toolTraceGroup") {
                const failedCount = item.messages.filter((message) => message.status === "failed").length;
                return (
                  <details
                    key={item.id}
                    className={`agent-tool-trace-group ${failedCount > 0 ? "failed" : ""}`}
                  >
                    <summary>
                      <span>{item.messages.length} tool call{item.messages.length === 1 ? "" : "s"}</span>
                      <span className="agent-trace-caret" aria-hidden="true">▸</span>
                    </summary>
                    <div className="agent-tool-trace-list">
                      {item.messages.map((message) => (
                        <details key={message.id} className={`agent-tool-trace-item ${message.status ?? ""}`}>
                          <summary>
                            <span>{message.toolName ?? "Method tool"}</span>
                            <span>{message.status === "streaming" ? "running" : message.status}</span>
                            {formatDuration(message.durationMs) && <span>{formatDuration(message.durationMs)}</span>}
                            <span className="agent-trace-caret" aria-hidden="true">▸</span>
                          </summary>
                          <div className="agent-tool-trace-detail">
                            {message.outputSummary && <div>{message.outputSummary}</div>}
                            {message.toolArguments && (
                              <div className="agent-tool-trace-json">
                                <strong>Parameters</strong>
                                <pre>{prettyJson(message.toolArguments)}</pre>
                              </div>
                            )}
                            {message.toolOutput && (
                              <div className="agent-tool-trace-json">
                                <strong>Output</strong>
                                <pre>{prettyJson(message.toolOutput)}</pre>
                              </div>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                );
              }
              return (
                <div key={item.id} className={`agent-message ${item.role} ${item.traceKind ?? ""} ${item.status ?? ""}`}>
                  <AgentMessageBody message={item} />
                </div>
              );
            })}
          </div>

          <form
            className="agent-chat-input"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="Describe or refine a Method"
              disabled={isSending && Boolean(activeTurn)}
            />
            <div className="agent-chat-input-footer">
              <div className="agent-chat-input-metrics" aria-label="Planning agent metrics">
                <span>{formatTokenCount(contextTokenEstimate)} context tokens</span>
                <span>{modelConfigLabel}</span>
              </div>
              <button type="submit" disabled={isSending || isConnecting}>
                {isSending ? "Sending" : "Send"}
              </button>
            </div>
          </form>
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
                disabled={!draft || derivedDraftReadiness(draft).blockers.length > 0 || isSavingMethod || isExecutingMethod}
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
          </section>

          {draft ? (
            <MethodGraph draft={draft} executionNodes={executionNodes} />
          ) : (
            <div className="agent-empty-visual">Saved Methods can be executed from the controls above.</div>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
