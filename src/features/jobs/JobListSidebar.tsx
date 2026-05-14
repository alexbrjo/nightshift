import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InferenceJob } from "../../database";
import { useActiveRefresh } from "../../hooks/useActiveRefresh";
import { formatDetailTimestamp, formatListTimestamp } from "../../utils/date";

interface JobListSidebarProps {
  selectedId?: number | null;
  onSelectJob: (jobId: number) => void;
  onNewJob: () => void;
  refreshKey?: number;
  isActive?: boolean;
}

function getStatusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
      return "status-completed";
    case "completed_with_errors":
      return "status-warning";
    case "running":
      return "status-running";
    case "failed":
      return "status-failed";
    case "pending":
    case "queued":
      return "status-pending";
    case "cancelled":
      return "status-cancelled";
    default:
      return "";
  }
}

function formatStatus(status: string): string {
  if (status === "completed_with_errors") return "Completed with errors";
  return status;
}

export default function JobListSidebar({
  selectedId = null,
  onSelectJob,
  onNewJob,
  refreshKey = 0,
  isActive = true,
}: JobListSidebarProps) {
  const [jobs, setJobs] = useState<InferenceJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const hasLoadedRef = useRef(false);

  const loadJobs = useCallback(async () => {
    if (!hasLoadedRef.current) setIsLoading(true);
    try {
      const jobList = await invoke<InferenceJob[]>("list_inference_jobs", {
        page: 1,
        pageSize: 50,
      });
      setJobs(Array.isArray(jobList) ? jobList : []);
      hasLoadedRef.current = true;
    } catch (error) {
      console.error("Failed to load jobs:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useActiveRefresh({
    isActive,
    refresh: loadJobs,
    intervalMs: 5000,
    refreshToken: refreshKey,
  });

  return (
    <aside className="job-list-sidebar">
      <header className="job-list-header">
        <h2>Jobs</h2>
        {jobs.length > 0 && (
          <button className="btn-primary btn-small" onClick={onNewJob}>
            + New
          </button>
        )}
      </header>

      {isLoading ? (
        <div className="loading-indicator">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="job-list-empty">
          <button className="resource-create-button" onClick={onNewJob}>
            Create a new job
          </button>
        </div>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => {
            const date = formatListTimestamp(job.created_at);
            const fullDate = formatDetailTimestamp(job.created_at);
            return (
              <li
                key={job.id}
                className={`job-item ${getStatusClass(job.status)}${
                  selectedId === job.id ? " selected" : ""
                }`}
                onClick={() => onSelectJob(job.id)}
              >
                <div className="job-primary-line">
                  <div className="job-name">{job.name}</div>
                  <span className={`status-badge ${getStatusClass(job.status)}`}>
                    {formatStatus(job.status)}
                  </span>
                </div>
                <div className="job-meta">
                  <span className="job-type-badge">
                    {job.job_type === "sample"
                      ? "Sample"
                      : job.job_type === "transform"
                        ? "Transform"
                        : "Inference"}
                  </span>
                  {date && (
                    <span className="job-relative-time" title={fullDate || undefined}>
                      {date}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
