import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InferenceJob } from "../database";
import { formatDateTime } from "../utils/date";

interface JobListSidebarProps {
  selectedId?: number | null;
  onSelectJob: (jobId: number) => void;
  onNewJob: () => void;
  refreshKey?: number;
}

function getStatusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
      return "status-completed";
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

export default function JobListSidebar({
  selectedId = null,
  onSelectJob,
  onNewJob,
  refreshKey = 0,
}: JobListSidebarProps) {
  const [jobs, setJobs] = useState<InferenceJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadJobs = useCallback(async () => {
    try {
      const jobList = await invoke<InferenceJob[]>("list_inference_jobs", {
        page: 1,
        pageSize: 50,
      });
      setJobs(Array.isArray(jobList) ? jobList : []);
    } catch (error) {
      console.error("Failed to load jobs:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, [loadJobs, refreshKey]);

  return (
    <aside className="job-list-sidebar">
      <header className="job-list-header">
        <h2>Jobs</h2>
        <button className="btn-primary btn-small" onClick={onNewJob}>
          + New
        </button>
      </header>

      {isLoading ? (
        <div className="loading-indicator">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="job-list-empty">
          <p>No inference jobs yet.</p>
          <button className="btn-secondary btn-small" onClick={onNewJob}>
            Create your first job
          </button>
        </div>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => {
            const date = formatDateTime(job.created_at);
            return (
              <li
                key={job.id}
                className={`job-item${selectedId === job.id ? " selected" : ""}`}
                onClick={() => onSelectJob(job.id)}
              >
                <div className="job-name">{job.name}</div>
                <div className="job-meta">
                  <span className={`status-badge ${getStatusClass(job.status)}`}>
                    {job.status}
                  </span>
                  {date && <span>{date}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
