// Collapsible debug pane shown below the planner chat. Surfaces the full
// system prompt, conversation history, the latest reasoning_content
// (chain-of-thought), the parsed planner turn, and the raw response body
// from `chat_complete`. Pure presentational — owns no state beyond the
// open/closed disclosure.

import type { ReactNode } from "react";
import type { PlannerTurn } from "../../utils/experimentSchema";
import type { PlannerContext } from "../../utils/agentSystemPrompt";

export interface ChatMessageView {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DebugTrace {
  reasoning: string | null;
  rawBody: string;
  parsedTurn: PlannerTurn | null;
  parseError: string | null;
  timestamp: number;
}

interface Props {
  open: boolean;
  onToggle: (open: boolean) => void;
  context: PlannerContext | null;
  messages: ChatMessageView[];
  trace: DebugTrace | null;
}

function DebugSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="debug-section">
      <summary>{title}</summary>
      {children}
    </details>
  );
}

function buildSystemPromptPreview(context: PlannerContext): string {
  // Mirror what the planner injects, but truncate file lists for readability.
  const trim = (arr: string[]) =>
    arr.length > 8
      ? `${arr.slice(0, 8).join(", ")}…+${arr.length - 8} more`
      : arr.join(", ");
  return [
    `prompt files: ${trim(context.promptFiles)}`,
    `data files: ${trim(context.dataFiles)}`,
    `schema files: ${trim(context.schemaFiles)}`,
    `transform scripts: ${trim(context.scriptFiles)}`,
    `default model: ${context.defaultModel ?? "(none)"}`,
    "(full system prompt is in the conversation as the first message — see Conversation section)",
  ].join("\n");
}

export default function PlannerDebugPanel({
  open,
  onToggle,
  context,
  messages,
  trace,
}: Props) {
  if (messages.length === 0 && !trace) return null;
  return (
    <details
      className="planner-debug"
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
    >
      <summary>Debug: prompt, history, raw output, CoT</summary>
      <div className="debug-body">
        <DebugSection title={`System prompt (${context ? "loaded" : "not yet loaded"})`}>
          <pre>{context ? buildSystemPromptPreview(context) : "(none)"}</pre>
        </DebugSection>
        <DebugSection title={`Conversation (${messages.length} messages)`}>
          <ol className="debug-messages">
            {messages.map((m, i) => (
              <li key={i}>
                <span className={`debug-role ${m.role}`}>{m.role}</span>
                <pre>{m.content}</pre>
              </li>
            ))}
          </ol>
        </DebugSection>
        {trace ? (
          <>
            <DebugSection title="Latest reasoning_content (CoT)">
              <pre>{trace.reasoning ?? "(model returned none)"}</pre>
            </DebugSection>
            <DebugSection title="Latest parsed turn">
              <pre>
                {trace.parsedTurn
                  ? JSON.stringify(trace.parsedTurn, null, 2)
                  : `parse error: ${trace.parseError ?? "(none)"}`}
              </pre>
            </DebugSection>
            <DebugSection title="Latest raw response body">
              <pre>{trace.rawBody}</pre>
            </DebugSection>
          </>
        ) : null}
      </div>
    </details>
  );
}
