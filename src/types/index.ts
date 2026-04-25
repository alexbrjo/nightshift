export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface FileTab {
  name: string;
  path: string;
  content: string;
  language?: string;
  modified?: boolean;
}
