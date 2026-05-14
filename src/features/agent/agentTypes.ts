export interface ChatMessage {
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

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ToolTraceGroup {
  id: string;
  role: "toolTraceGroup";
  messages: ChatMessage[];
}

export type ChatItem = ChatMessage | ToolTraceGroup;
