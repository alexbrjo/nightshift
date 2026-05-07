// Renderable cards for each PlannerTurn shape. Pure presentational + state
// for the in-progress answer; the orchestrator owns history and submission.

import { useState } from "react";
import type { PlannerTurn } from "../../utils/experimentSchema";

interface QuestionCardProps {
  turn: Extract<PlannerTurn, { kind: "question" }>;
  onConfirm: (answer: string) => void;
  disabled: boolean;
}

export function QuestionCard({ turn, onConfirm, disabled }: QuestionCardProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [other, setOther] = useState("");
  const [otherActive, setOtherActive] = useState(false);

  const toggle = (i: number) => {
    if (turn.multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      });
    } else {
      setSelected(new Set([i]));
      setOtherActive(false);
    }
  };

  const handleSubmit = () => {
    const labels = Array.from(selected).map((i) => turn.options[i]?.label).filter(Boolean);
    if (otherActive && other.trim()) labels.push(other.trim());
    if (labels.length === 0) return;
    onConfirm(labels.join(", "));
  };

  const canSubmit =
    !disabled && (selected.size > 0 || (otherActive && other.trim().length > 0));

  return (
    <div className="planner-card assistant">
      <span className="header">{turn.header}</span>
      {turn.acknowledgment ? (
        <div className="acknowledgment">{turn.acknowledgment}</div>
      ) : null}
      <div className="question">{turn.question}</div>
      <div className="options">
        {turn.options.map((opt, i) => (
          <label key={i} className="option">
            <input
              type={turn.multiSelect ? "checkbox" : "radio"}
              name="planner-q"
              checked={selected.has(i)}
              onChange={() => toggle(i)}
              disabled={disabled}
            />
            <span>
              {opt.label}
              {opt.description ? <span className="desc">{opt.description}</span> : null}
            </span>
          </label>
        ))}
        {turn.allowOther ? (
          <label className="option">
            <input
              type={turn.multiSelect ? "checkbox" : "radio"}
              name="planner-q"
              checked={otherActive}
              onChange={() => {
                setOtherActive((p) => !p);
                if (!turn.multiSelect) setSelected(new Set());
              }}
              disabled={disabled}
            />
            <span>Other / type your own</span>
          </label>
        ) : null}
        {otherActive ? (
          <textarea
            className="other-input"
            rows={2}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="Type a custom answer…"
            disabled={disabled}
          />
        ) : null}
      </div>
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

interface FreeformCardProps {
  turn: Extract<PlannerTurn, { kind: "freeform" }>;
  onConfirm: (answer: string) => void;
  disabled: boolean;
}

export function FreeformCard({ turn, onConfirm, disabled }: FreeformCardProps) {
  // Start blank — `turn.placeholder` is shown as the textarea's hint
  // (vanishes on first keystroke). Seeding the value would force the user
  // to clear example text before typing their own answer.
  const [text, setText] = useState("");

  return (
    <div className="planner-card assistant">
      <span className="header">{turn.header}</span>
      {turn.acknowledgment ? (
        <div className="acknowledgment">{turn.acknowledgment}</div>
      ) : null}
      <div className="question">{turn.prompt}</div>
      <textarea
        className="freeform-input"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        placeholder={turn.placeholder ?? "Type your answer…"}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => text.trim() && onConfirm(text.trim())}
          disabled={disabled || !text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export function UserAnswerCard({ text }: { text: string }) {
  return <div className="planner-card user">{text}</div>;
}

interface HistoryTurnProps {
  header: string;
  acknowledgment?: string;
  body: string;
}

/** Read-only summary of a past assistant turn so the user can scroll back
 *  through the conversation instead of staring at only the current question. */
export function HistoryTurnCard({ header, acknowledgment, body }: HistoryTurnProps) {
  return (
    <div className="planner-card assistant history">
      <span className="header">{header}</span>
      {acknowledgment ? <div className="acknowledgment">{acknowledgment}</div> : null}
      <div className="history-body">{body}</div>
    </div>
  );
}

interface ProposalCardProps {
  acknowledgment?: string;
  onSave: () => void;
  onRefine: () => void;
  disabled: boolean;
  saving: boolean;
}

export function ProposalCard({
  acknowledgment,
  onSave,
  onRefine,
  disabled,
  saving,
}: ProposalCardProps) {
  return (
    <div className="planner-card assistant">
      <span className="header">Proposal</span>
      {acknowledgment ? <div className="acknowledgment">{acknowledgment}</div> : null}
      <div className="question">
        I have everything I need. Review the YAML on the right, then save the
        bundle or ask me to refine.
      </div>
      <div className="actions">
        <button type="button" onClick={onRefine} disabled={disabled || saving}>
          Refine
        </button>
        <button type="button" className="primary" onClick={onSave} disabled={disabled || saving}>
          {saving ? "Saving…" : "Save bundle"}
        </button>
      </div>
    </div>
  );
}
