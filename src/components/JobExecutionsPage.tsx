import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { JobExecution } from "../database";
import {
  executionListForDefinition,
  experimentStart,
} from "../api/orchestrator";
import { formatRelativeTime } from "../utils/date";
import { useToast } from "./Toast";
import DefinitionTreeSidebar from "./DefinitionTreeSidebar";
import ExecutionViewPage from "./ExecutionViewPage";

interface JobExecutionsPageProps {
  isActive?: boolean;
}

function statusClass(status: string): string {
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

/**
 * Job Executions section: definition picker on the left (the same
 * tree sidebar from the Definitions page), past executions for the
 * selected definition in the middle, and the live execution view on
 * the right. "+ Start execution" lives at the top of the middle pane
 * and acts on the currently-selected definition.
 */
export default function JobExecutionsPage({ isActive = true }: JobExecutionsPageProps) {
  const [selectedDefId, setSelectedDefId] = useState<number | null>(null);
  const [selectedExecId, setSelectedExecId] = useState<number | null>(null);
  const [executions, setExecutions] = useState<JobExecution[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const { showToast } = useToast();

  const loadExecutions = useCallback(async () => {
    if (selectedDefId === null) {
      setExecutions([]);
      return;
    }
    setIsLoadingList(true);
    try {
      const list = await executionListForDefinition(selectedDefId, 50);
      setExecutions(list);
      // Auto-select the most recent execution if nothing is selected (or if
      // the previously-selected exec belongs to a different definition).
      setSelectedExecId((prev) => {
        if (prev !== null && list.some((e) => e.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (e) {
      console.error("Failed to load executions:", e);
    } finally {
      setIsLoadingList(false);
    }
  }, [selectedDefId]);

  useEffect(() => {
    void loadExecutions();
  }, [loadExecutions]);

  // Refresh the list whenever any execution status changes for this
  // definition's runs (started, completed, failed, cancelled).
  useEffect(() => {
    if (!isActive || selectedDefId === null) return;
    const unlisteners: Array<Promise<() => void>> = [
      listen("experiment-started", () => void loadExecutions()),
      listen("experiment-completed", () => void loadExecutions()),
      listen("experiment-failed", () => void loadExecutions()),
      listen("experiment-cancelled", () => void loadExecutions()),
      listen("execution-status", () => void loadExecutions()),
    ];
    return () => {
      unlisteners.forEach((p) => void p.then((fn) => fn()));
    };
  }, [isActive, selectedDefId, loadExecutions]);

  const handleStart = useCallback(async () => {
    if (selectedDefId === null) return;
    setIsStarting(true);
    try {
      const execId = await experimentStart(selectedDefId);
      showToast(`Started job execution ${execId}`, "success");
      // The list refresh will pick it up via the experiment-started event;
      // optimistically select so the right pane updates immediately.
      setSelectedExecId(execId);
      void loadExecutions();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Failed to start execution:", e);
      showToast(`Failed to start: ${msg}`, "error");
    } finally {
      setIsStarting(false);
    }
  }, [selectedDefId, loadExecutions, showToast]);

  return (
    <div className="job-executions-page">
      <DefinitionTreeSidebar
        selectedId={selectedDefId}
        onSelectDefinition={setSelectedDefId}
        isActive={isActive}
        title="Definitions"
      />
      <div className="executions-list-pane">
        <header className="job-list-header">
          <h2>Job executions</h2>
          <button
            type="button"
            className="btn-primary btn-small"
            onClick={handleStart}
            disabled={selectedDefId === null || isStarting}
            title={
              selectedDefId === null
                ? "Select a definition first"
                : "Start a new execution of the selected definition"
            }
          >
            {isStarting ? "Starting…" : "+ Start execution"}
          </button>
        </header>

        {selectedDefId === null ? (
          <div className="job-list-empty">
            <p>Select a definition to see its job executions.</p>
          </div>
        ) : isLoadingList && executions.length === 0 ? (
          <div className="loading-indicator">Loading…</div>
        ) : executions.length === 0 ? (
          <div className="job-list-empty">
            <p>No executions yet for this definition.</p>
          </div>
        ) : (
          <ul className="job-list">
            {executions.map((exec) => {
              const cls = statusClass(exec.status);
              const isSelected = selectedExecId === exec.id;
              return (
                <li
                  key={exec.id}
                  className={`job-item ${cls}${isSelected ? " selected" : ""}`}
                  onClick={() => setSelectedExecId(exec.id)}
                >
                  <div className="job-primary-line">
                    <div className="job-name">execution {exec.id}</div>
                    <span className={`status-badge ${cls}`}>{exec.status}</span>
                  </div>
                  <div className="job-meta">
                    <span className="job-type-badge">
                      {exec.startedAt ? "started" : "queued"}
                    </span>
                    <span className="job-relative-time">
                      {formatRelativeTime(exec.createdAt)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="executions-detail-pane">
        {selectedExecId === null ? (
          <div className="editor-placeholder">
            {selectedDefId === null
              ? "Select a definition to see its executions."
              : "Select a job execution to inspect, or start a new one."}
          </div>
        ) : (
          <ExecutionViewPage key={selectedExecId} rootExecId={selectedExecId} />
        )}
      </div>
    </div>
  );
}
