import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

import type { JobExecution, ExecutionStatus } from "../database";
import {
  executionGet,
  executionGetTree,
  experimentCancel,
  type ExecutionStatusPayload,
  type ExecutionProgressPayload,
} from "../api/orchestrator";
import ExecutionCollectionView from "./ExecutionCollectionView";
import LedgerTimeline from "./LedgerTimeline";

interface ExecutionViewPageProps {
  rootExecId: number;
  /** Returns to designer mode. */
  onBack: () => void;
}

interface ProgressState {
  completed: number;
  failed: number;
  total: number;
}

function statusClass(status: ExecutionStatus | string): string {
  switch (status) {
    case "completed":
      return "status-completed";
    case "running":
      return "status-running";
    case "failed":
      return "status-failed";
    case "cancelled":
      return "status-cancelled";
    case "pending":
    default:
      return "status-pending";
  }
}

export default function ExecutionViewPage({ rootExecId, onBack }: ExecutionViewPageProps) {
  const [tree, setTree] = useState<JobExecution[]>([]);
  const [root, setRoot] = useState<JobExecution | null>(null);
  const [progress, setProgress] = useState<ProgressState>({ completed: 0, failed: 0, total: 0 });
  const [isCancelling, setIsCancelling] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [rootRow, treeRows] = await Promise.all([
        executionGet(rootExecId),
        executionGetTree(rootExecId),
      ]);
      setRoot(rootRow);
      setTree(treeRows);
    } catch (error) {
      console.error("Failed to load execution:", error);
    }
  }, [rootExecId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Subscribe to all execution / experiment events for this run. We re-fetch
  // the row on every status change so the rest of the UI sees the canonical
  // shape; progress-only events update the local counter without a round-trip.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<Promise<() => void>> = [];

    const matchesRun = (id: number) => tree.some((e) => e.id === id) || id === rootExecId;

    unlisteners.push(
      listen<ExecutionStatusPayload>("execution-status", (event) => {
        if (cancelled || !matchesRun(event.payload.execId)) return;
        void reload();
      }),
    );
    unlisteners.push(
      listen<ExecutionProgressPayload>("execution-progress", (event) => {
        if (cancelled || !matchesRun(event.payload.execId)) return;
        // For single-leaf v1, the leaf's progress IS the experiment's progress.
        // Tree-level aggregation lands in checkpoint 6.
        setProgress({
          completed: event.payload.completed,
          failed: event.payload.failed,
          total: event.payload.total,
        });
      }),
    );
    for (const evt of [
      "experiment-completed",
      "experiment-failed",
      "experiment-cancelled",
    ] as const) {
      unlisteners.push(
        listen<{ rootExecId: number }>(evt, (event) => {
          if (cancelled || event.payload.rootExecId !== rootExecId) return;
          void reload();
        }),
      );
    }

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => void p.then((fn) => fn()));
    };
  }, [reload, rootExecId, tree]);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    try {
      await experimentCancel(rootExecId);
    } catch (error) {
      console.error("Failed to cancel experiment:", error);
    } finally {
      setIsCancelling(false);
    }
  }, [rootExecId]);

  if (!root) {
    return (
      <div className="job-view-page">
        <div className="loading-indicator">Loading execution…</div>
      </div>
    );
  }

  const isTerminal =
    root.status === "completed" || root.status === "failed" || root.status === "cancelled";
  const progressPercent =
    progress.total > 0
      ? ((progress.completed + progress.failed) / progress.total) * 100
      : 0;

  // For single-leaf v1, the "leaf" is the root execution itself. When group
  // workers land in checkpoint 6, this becomes the deepest running leaf.
  const leafExecId = tree.length > 0 ? tree[tree.length - 1].id : root.id;

  return (
    <div className="job-view-page">
      <div className="page-header">
        <button className="btn-secondary" onClick={onBack}>
          ← Back to designer
        </button>
        <h1>Execution {rootExecId}</h1>
        <div className="header-actions">
          {!isTerminal && (
            <button
              className="btn-danger"
              onClick={handleCancel}
              disabled={isCancelling}
            >
              {isCancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      </div>

      <div className={`status-banner ${statusClass(root.status)}`}>
        <span className="status-text">{root.status}</span>
        {root.error && <pre className="status-error">{root.error}</pre>}
      </div>

      {(root.status === "running" || root.status === "pending") && progress.total > 0 && (
        <div className="progress-section">
          <div className="progress-header">
            <span>
              Progress: {progress.completed + progress.failed}/{progress.total}
            </span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <div className="progress-bar-container">
            <div className="progress-bar" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="progress-stats">
            <span className="stat completed">{progress.completed} completed</span>
            <span className="stat failed">{progress.failed} failed</span>
          </div>
        </div>
      )}

      {/* For multi-node trees we'd render each as a separate badge here. For
          single-leaf v1 there's just the root. */}
      {tree.length > 1 && (
        <div className="execution-tree">
          <h2>Tree</h2>
          <ul>
            {tree.map((node) => (
              <li key={node.id}>
                <span className={`status-badge ${statusClass(node.status)}`}>
                  {node.status}
                </span>
                <span className="execution-tree-id">execution {node.id}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="collections-section">
        <h2>Output</h2>
        <ExecutionCollectionView execId={leafExecId} liveProgress={!isTerminal} />
      </div>

      <LedgerTimeline execId={leafExecId} />
    </div>
  );
}
