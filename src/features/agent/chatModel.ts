import type { CodexAppServerEvent, DesignAgentConfig, MethodDocument } from "../../database";
import type { ChatItem, ChatMessage, ChatSession } from "./agentTypes";

const RAW_SCRIPT_OR_STYLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
export const NEW_CHAT_DRAFT_KEY = "__nightshift_new_chat__";
export const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: "Describe the Method you want to design. I can help shape the workflow and keep the draft state visible beside chat.",
  status: "completed",
};

export function appendDelta(messages: ChatMessage[], itemId: string, delta: string): ChatMessage[] {
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

export function upsertAssistantMessage(messages: ChatMessage[], itemId: string, text: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === itemId);
  if (index === -1) {
    return [...messages, { id: itemId, role: "assistant", text, status: "completed" }];
  }
  return messages.map((message, currentIndex) =>
    currentIndex === index ? { ...message, text, status: "completed" } : message,
  );
}

export function upsertTraceMessage(
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

export function formatDuration(durationMs?: number) {
  if (durationMs === undefined || durationMs === null) return null;
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

export function toolTraceText(payload: CodexAppServerEvent): string {
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

export function prettyJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = JSON.stringify(value, null, 2);
  return text.length > 5000 ? `${text.slice(0, 5000)}\n... truncated` : text;
}

export function safeMarkdownHref(href?: string) {
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

export function markdownSource(text: string) {
  return text.replace(RAW_SCRIPT_OR_STYLE_BLOCK, "");
}

export const METHOD_DRAFT_MUTATION_TOOLS = new Set([
  "create_method_draft",
  "update_method_draft_metadata",
  "update_method_draft_execution_config",
  "replace_method_draft_graph",
]);

export function dispatchAgentFileChange(toolName?: string) {
  if (!toolName) return;
  if (!METHOD_DRAFT_MUTATION_TOOLS.has(toolName)) return;
  window.dispatchEvent(new CustomEvent("nightshift-method-draft-mutated"));
  window.dispatchEvent(new CustomEvent("nightshift-project-files-changed"));
}

export function groupToolTraceMessages(messages: ChatMessage[]): ChatItem[] {
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

export function userFacingError(err: unknown) {
  return `I could not reach the design agent: ${String(err)}`;
}

export function fallbackChatTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.text.trim());
  if (!firstUserMessage) return "New planning chat";
  const normalized = firstUserMessage.text.trim().replace(/\s+/g, " ");
  return normalized.length > 42 ? `${normalized.slice(0, 39)}...` : normalized;
}

export function createChatSession(messages: ChatMessage[] = [], id?: string): ChatSession {
  const now = new Date().toISOString();
  return {
    id: id ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

export function isDesignAgentConfig(value: unknown): value is DesignAgentConfig {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && "model" in value
      && "reasoningSummary" in value
      && "maxToolLoops" in value,
  );
}

export function normalizeChatSessions(value: unknown): ChatSession[] {
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
      messages: chat.messages.filter((message) => message.id !== WELCOME_MESSAGE.id),
    }))
    .filter((chat) => chat.messages.length > 0)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function loadPersistedChatSessions(): ChatSession[] {
  return [];
}

export function shouldPersistProjectConversations(
  chatPersistenceReady: boolean,
  conversationCount: number,
  persistedConversationCount: number,
) {
  if (!chatPersistenceReady) return false;
  return conversationCount > 0 || persistedConversationCount > 0;
}

export function visibleTranscript(messages: ChatMessage[]) {
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

export function agentInputWithContext(messages: ChatMessage[], nextMessage: string) {
  const transcript = visibleTranscript(messages);
  if (!transcript) return nextMessage;
  return [
    "Use this existing planning chat context before answering or changing the Method draft:",
    transcript,
    "New user message:",
    nextMessage,
  ].join("\n\n");
}

export function estimateTokenCount(text: string) {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

export function formatTokenCount(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : String(count);
}

export function isMissingProjectError(err: unknown) {
  const message = String(err);
  return message.includes("No project folder is open")
    || message.includes("Open a project folder before starting");
}

export function isMethodDocument(value: unknown): value is MethodDocument {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && "workflow" in value
      && "title" in value
      && "objective" in value,
  );
}
