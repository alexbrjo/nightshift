import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { executionGetLedger } from "../api/orchestrator";
import { formatRelativeTime } from "../utils/date";

interface LedgerTimelineProps {
  execId: number | null;
}

interface LedgerEntry {
  step?: string | number;
  timestamp?: string;
  kind?: string;
  message?: string;
  [extra: string]: unknown;
}

/**
 * Renders the `job_execution.ledger` JSON value as a timestamped step list.
 * The shape is deliberately permissive — analysis workers append entries
 * with their own kind/message keys; this component just shows what's there.
 *
 * v1: shell only. AnalysisWorker is the first producer of meaningful ledger
 * entries (lands in checkpoint 8); until then this renders an empty state.
 */
export default function LedgerTimeline({ execId }: LedgerTimelineProps) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (execId === null) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const ledger = await executionGetLedger(execId);
        if (cancelled) return;
        if (Array.isArray(ledger)) {
          setEntries(ledger as LedgerEntry[]);
        } else if (ledger && typeof ledger === "object" && Array.isArray((ledger as { entries?: unknown }).entries)) {
          setEntries((ledger as { entries: LedgerEntry[] }).entries);
        } else {
          setEntries([]);
        }
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    const p = listen<{ execId: number }>("execution-ledger-updated", (event) => {
      if (event.payload.execId === execId) void load();
    });
    return () => {
      cancelled = true;
      void p.then((fn) => fn());
    };
  }, [execId]);

  if (execId === null) return null;

  return (
    <section className="ledger-timeline">
      <h3>Agent Ledger</h3>
      {isLoading && entries.length === 0 ? (
        <div className="loading-indicator">Loading…</div>
      ) : entries.length === 0 ? (
        <p className="hint">
          No agent steps recorded. Analysis workers append progress here as they run.
        </p>
      ) : (
        <ol className="ledger-timeline-list">
          {entries.map((entry, idx) => (
            <li key={idx} className="ledger-timeline-item">
              <span className="ledger-step">{entry.step ?? idx + 1}</span>
              {entry.kind && <span className="ledger-kind">{entry.kind}</span>}
              {entry.message && <span className="ledger-message">{entry.message}</span>}
              {entry.timestamp && (
                <span className="ledger-time">{formatRelativeTime(entry.timestamp)}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
