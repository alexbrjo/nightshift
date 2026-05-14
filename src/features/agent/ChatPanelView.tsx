import { useMemo, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { CodexTurnSummary } from "../../database";
import type { ChatItem, ChatMessage } from "./agentTypes";
import {
  WELCOME_MESSAGE,
  agentInputWithContext,
  estimateTokenCount,
  formatDuration,
  formatTokenCount,
  groupToolTraceMessages,
  markdownSource,
  prettyJson,
  safeMarkdownHref,
} from "./chatModel";

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

function ChatItemsView({ items }: { items: ChatItem[] }) {
  return (
    <>
      {items.length === 0 && (
        <div className="agent-chat-welcome">
          <AgentMessageBody message={WELCOME_MESSAGE} />
        </div>
      )}
      {items.map((item) => {
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
                      <span className={`agent-tool-trace-status ${message.status ?? ""}`}>
                        {message.status === "streaming" ? "running" : message.status}
                      </span>
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
    </>
  );
}

function ChatComposer({
  input,
  setInput,
  onSubmit,
  isSending,
  activeTurn,
  isSendDisabled,
  isConnecting,
  contextTokenEstimate,
  modelConfigLabel,
  inputRef,
}: {
  input: string;
  setInput: (value: string) => void;
  onSubmit: () => void;
  isSending: boolean;
  activeTurn: CodexTurnSummary | null;
  isSendDisabled?: boolean;
  isConnecting: boolean;
  contextTokenEstimate: number;
  modelConfigLabel: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <form
      className="agent-chat-input"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        ref={inputRef}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
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
        <button type="submit" disabled={(isSendDisabled ?? isSending) || isConnecting}>
          {isSending ? "Sending" : "Send"}
        </button>
      </div>
    </form>
  );
}

export function ChatPanelView({
  messages,
  input,
  setInput,
  onSubmit,
  isSending,
  activeTurn,
  isSendDisabled,
  isConnecting,
  modelConfigLabel,
  inputRef,
}: {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  onSubmit: () => void;
  isSending: boolean;
  activeTurn: CodexTurnSummary | null;
  isSendDisabled?: boolean;
  isConnecting: boolean;
  modelConfigLabel: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const items = useMemo(() => groupToolTraceMessages(messages), [messages]);
  const contextTokenEstimate = useMemo(
    () => estimateTokenCount(agentInputWithContext(messages, input.trim())),
    [input, messages],
  );
  return (
    <div className="agent-chat-workspace panel-embedded">
      <div className="agent-chat-panel">
        <div className="agent-chat-scroll">
          <ChatItemsView items={items} />
        </div>
        <ChatComposer
          input={input}
          setInput={setInput}
          onSubmit={onSubmit}
          isSending={isSending}
          activeTurn={activeTurn}
          isSendDisabled={isSendDisabled}
          isConnecting={isConnecting}
          contextTokenEstimate={contextTokenEstimate}
          modelConfigLabel={modelConfigLabel}
          inputRef={inputRef}
        />
      </div>
    </div>
  );
}
