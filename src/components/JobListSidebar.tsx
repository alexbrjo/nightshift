import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InferenceJob } from "../database";

interface JobListSidebarProps {
  onSelectJob: (jobId: number) => void;
  onNewJob: () => void;
}

export default function JobListSidebar({ onSelectJob, onNewJob }: JobListSidebarProps) {
  const [jobs, setJobs] = useState<InferenceJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadJobs = useCallback(async () => {
    try {
      const jobList = await invoke<InferenceJob[]>("list_inference_jobs", {
        page: 1,
        pageSize: 50,
      });
      setJobs(jobList);
    } catch (error) {
      console.error("Failed to load jobs:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();

    // Set up polling for job status updates
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, [loadJobs]);

  const getStatusIcon = (status: string): string => {
    switch (status.toLowerCase()) {
      case "pending":
        return "⏳";
      case "queued":
        return "📋";
      case "running":
        return "▶️";
      case "completed":
        return "✅";
      case "failed":
        return "❌";
      case "cancelled":
        return "⏹️";
      default:
        return "📝";
    }
  };

  const getStatusClass = (status: string): string => {
    switch (status.toLowerCase()) {
      case "completed":
        return "status-completed";
      case "running":
        return "status-running";
      case "failed":
        return "status-failed";
      case "pending":
        return "status-pending";
      default:
        return "";
    }
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (isLoading) {
    return (
      <div className="job-list-sidebar">
        <div className="sidebar-header">
          <h2>Inference Jobs</h2>
          <button className="btn-primary" onClick={onNewJob}>
            + New Job
          </button>
        </div>
        <div className="loading-indicator">Loading jobs...</div>
      </div>
    );
  }

  return (
    <div className="job-list-sidebar">
      <div className="sidebar-header">
        <h2>Inference Jobs</h2>
        <button className="btn-primary" onClick={onNewJob}>
          + New Job
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="empty-state">
          <p>No inference jobs yet.</p>
          <button className="btn-secondary" onClick={onNewJob}>
            Create your first job
          </button>
        </div>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => (
            <li
              key={job.id}
              className={`job-item ${getStatusClass(job.status)}`}
              onClick={() => onSelectJob(job.id)}
            >
              <div className="job-icon">{getStatusIcon(job.status)}</div>
              <div className="job-info">
                <div className="job-name">{job.name}</div>
                <div className="job-meta">
                  <span className={`status-badge ${getStatusClass(job.status)}`}>
                    {job.status}
                  </span>
                  <span className="job-date">{formatDate(job.created_at)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
