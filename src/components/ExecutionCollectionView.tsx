import { useEffect, useMemo, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

import type { ExecutionCollectionItem } from "../database";
import { executionGetCollection } from "../api/orchestrator";

interface ExecutionCollectionViewProps {
  execId: number;
  /** Re-fetch on every progress event for this exec_id; default true. */
  liveProgress?: boolean;
}

const PAGE_SIZE = 50;
const CELL_TRUNCATE_LENGTH = 80;

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "status-completed";
    case "running":
      return "status-running";
    case "failed":
      return "status-failed";
    case "skipped":
      return "status-warning";
    case "pending":
    default:
      return "status-pending";
  }
}

function parseData(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function truncate(value: string): string {
  return value.length > CELL_TRUNCATE_LENGTH
    ? `${value.slice(0, CELL_TRUNCATE_LENGTH)}…`
    : value;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Shows the per-row state of an execution-scoped collection: status,
 * attempt, latency, and the auto-detected data columns. Pending/running
 * rows render as placeholders so the user sees live progress as the
 * worker fills them in.
 */
export default function ExecutionCollectionView({
  execId,
  liveProgress = true,
}: ExecutionCollectionViewProps) {
  const [items, setItems] = useState<ExecutionCollectionItem[]>([]);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const rows = await executionGetCollection(execId, page, PAGE_SIZE);
      setItems(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load collection");
    } finally {
      setIsLoading(false);
    }
  }, [execId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh on progress events for this execution.
  useEffect(() => {
    if (!liveProgress) return;
    const p = listen<{ execId: number }>("execution-progress", (event) => {
      if (event.payload.execId === execId) void load();
    });
    return () => {
      void p.then((fn) => fn());
    };
  }, [execId, liveProgress, load]);

  const dataColumns = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const item of items) {
      const data = parseData(item.data);
      if (!data) continue;
      for (const key of Object.keys(data)) {
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(key);
        }
      }
    }
    return ordered;
  }, [items]);

  if (isLoading && items.length === 0) {
    return <div className="loading-indicator">Loading collection…</div>;
  }
  if (error) {
    return <div className="form-error">{error}</div>;
  }
  if (items.length === 0) {
    return <p className="hint">No items yet — the worker hasn't run any rows.</p>;
  }

  return (
    <div className="execution-collection-view">
      <table className="collection-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Status</th>
            <th>Attempt</th>
            <th>Latency</th>
            {dataColumns.map((c) => (
              <th key={c}>{c}</th>
            ))}
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const data = parseData(item.data);
            return (
              <tr key={item.id} className={statusClass(item.status)}>
                <td>{item.itemIndex + 1}</td>
                <td>
                  <span className={`status-badge ${statusClass(item.status)}`}>
                    {item.status}
                  </span>
                </td>
                <td>{item.attempt}</td>
                <td>{item.latencyMs != null ? `${item.latencyMs}ms` : ""}</td>
                {dataColumns.map((col) => (
                  <td key={col} title={data ? formatCell(data[col]) : ""}>
                    {data ? truncate(formatCell(data[col])) : ""}
                  </td>
                ))}
                <td className="cell-error">{item.error ? truncate(item.error) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="collection-pager">
        <button
          type="button"
          className="btn-secondary btn-small"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
        >
          ← Prev
        </button>
        <span className="collection-page-indicator">Page {page}</span>
        <button
          type="button"
          className="btn-secondary btn-small"
          onClick={() => setPage((p) => p + 1)}
          disabled={items.length < PAGE_SIZE}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
