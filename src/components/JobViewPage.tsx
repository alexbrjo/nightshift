import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { InferenceJob, Collection } from "../database";
import { formatLongDateTime } from "../utils/date";

interface JobViewPageProps {
  jobId: number;
  onBack?: () => void;
  onViewCollection?: (collectionId: number) => void;
}

export default function JobViewPage({ jobId, onBack, onViewCollection }: JobViewPageProps) {
  const [job, setJob] = useState<InferenceJob | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [progress, setProgress] = useState({
    currentSample: 0,
    totalSamples: 0,
    completedSamples: 0,
    failedSamples: 0,
  });
  const [isStreaming, setIsStreaming] = useState(false);

  const loadJob = useCallback(async () => {
    try {
      const jobData = await invoke<InferenceJob>("get_inference_job", { id: jobId });
      setJob(jobData);
      setProgress({
        currentSample: 0,
        totalSamples: jobData.samples,
        completedSamples: 0,
        failedSamples: 0,
      });
    } catch (error) {
      console.error("Failed to load job:", error);
    } finally {
      setIsLoading(false);
    }
  }, [jobId]);

  const loadCollections = useCallback(async () => {
    try {
      const collectionsData = await invoke<Collection[]>("get_collections_for_job", { jobId });
      setCollections(collectionsData);
    } catch (error) {
      console.error("Failed to load collections:", error);
    }
  }, [jobId]);

  useEffect(() => {
    setIsLoading(true);
    loadJob();
    loadCollections();

    // Listener registration is async, so an early unmount can race with it.
    // Track the registered unlisten fns and a cancellation flag; if cleanup
    // runs before listeners resolve, we'll unsubscribe them as soon as they do.
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    (async () => {
      try {
        const fns = await Promise.all([
          listen<{ job_id: number; total_samples: number }>("job-started", (event) => {
            if (event.payload.job_id !== jobId) return;
            setIsStreaming(true);
            setProgress((prev) => ({
              ...prev,
              totalSamples: event.payload.total_samples ?? prev.totalSamples,
            }));
          }),
          listen("sample-completed", () => {
            setProgress((prev) => ({
              ...prev,
              completedSamples: prev.completedSamples + 1,
            }));
          }),
          listen("sample-failed", () => {
            setProgress((prev) => ({
              ...prev,
              failedSamples: prev.failedSamples + 1,
            }));
          }),
          listen<{ job_id: number }>("job-completed", (event) => {
            if (event.payload.job_id !== jobId) return;
            setIsStreaming(false);
            loadJob();
            loadCollections();
          }),
          listen<{ job_id: number }>("job-cancelled", (event) => {
            if (event.payload.job_id !== jobId) return;
            setIsStreaming(false);
            loadJob();
            loadCollections();
          }),
          listen<{ job_id: number }>("job-failed", (event) => {
            if (event.payload.job_id !== jobId) return;
            setIsStreaming(false);
            loadJob();
            loadCollections();
          }),
        ]);

        if (cancelled) {
          fns.forEach((fn) => fn());
        } else {
          unlistens.push(...fns);
        }
      } catch (err) {
        console.error("Failed to register job event listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
  }, [loadJob, loadCollections, jobId]);

  const handleStartJob = async () => {
    try {
      await invoke("subscribe_to_job_status", { jobId });
      setIsStreaming(true);
    } catch (error) {
      console.error("Failed to start job:", error);
    }
  };

  const handleCancelJob = async () => {
    try {
      await invoke("cancel_inference_job", { jobId });
      setIsStreaming(false);
      loadJob();
    } catch (error) {
      console.error("Failed to cancel job:", error);
    }
  };

  const handleExportYaml = async () => {
    try {
      const yamlContent = await invoke<string>("export_job_to_yaml", { jobId });
      
      // Create download link
      const blob = new Blob([yamlContent], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${job?.name || "job"}_config.yaml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Failed to export YAML:", error);
    }
  };

  const handleViewCollection = () => {
    if (collections.length > 0 && onViewCollection) {
      // Use the first collection (or could show a selection dialog for multiple)
      onViewCollection(collections[0].id);
    }
  };

  if (isLoading) {
    return (
      <div className="job-view-page">
        <div className="loading-indicator">Loading job details...</div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="job-view-page">
        <div className="error-message">Job not found</div>
        {onBack && (
          <button className="btn-secondary" onClick={onBack}>
            Back to Job List
          </button>
        )}
      </div>
    );
  }

  const progressPercent = progress.totalSamples > 0
    ? ((progress.completedSamples + progress.failedSamples) / progress.totalSamples) * 100
    : 0;

  return (
    <div className="job-view-page">
      {/* Header */}
      <div className="page-header">
        {onBack && (
          <button className="btn-secondary" onClick={onBack}>
            ← Back
          </button>
        )}
        <h1>{job.name}</h1>
        <div className="header-actions">
          {job.status === "pending" && (
            <button className="btn-primary" onClick={handleStartJob}>
              Start Job
            </button>
          )}
          {(job.status === "running" || isStreaming) && (
            <button className="btn-danger" onClick={handleCancelJob}>
              Cancel Job
            </button>
          )}
          <button className="btn-secondary" onClick={handleExportYaml}>
            Export YAML
          </button>
        </div>
      </div>

      {/* Status Banner */}
      <div className={`status-banner status-${job.status.toLowerCase()}`}>
        <span className="status-text">{job.status.toUpperCase()}</span>
      </div>

      {/* Progress Bar */}
      {(job.status === "running" || isStreaming) && (
        <div className="progress-section">
          <div className="progress-header">
            <span>Progress: {progress.completedSamples + progress.failedSamples}/{progress.totalSamples}</span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <div className="progress-bar-container">
            <div 
              className="progress-bar" 
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="progress-stats">
            <span className="stat completed">{progress.completedSamples} completed</span>
            <span className="stat failed">{progress.failedSamples} failed</span>
          </div>
        </div>
      )}

      {/* Configuration Summary */}
      <div className="config-section">
        <h2>Configuration</h2>
        
        <div className="config-grid">
          <div className="config-group">
            <h3>Prompt & Data</h3>
            <dl>
              <dt>Prompt File</dt>
              <dd>{job.prompt_file}</dd>
              
              <dt>Data Source</dt>
              <dd>{job.data_source}</dd>
              
              <dt>Samples</dt>
              <dd>{job.samples} ({job.strategy})</dd>
            </dl>
          </div>

          <div className="config-group">
            <h3>LLM Configuration</h3>
            <dl>
              <dt>Provider</dt>
              <dd>{job.provider}</dd>
              
              <dt>Model</dt>
              <dd>{job.model}</dd>
              
              <dt>Server URL</dt>
              <dd>{job.server_url}</dd>
              
              {job.temperature !== undefined && job.temperature !== null && (
                <>
                  <dt>Temperature</dt>
                  <dd>{job.temperature}</dd>
                </>
              )}
              
              {job.max_tokens !== undefined && job.max_tokens !== null && (
                <>
                  <dt>Max Tokens</dt>
                  <dd>{job.max_tokens}</dd>
                </>
              )}
              
              {job.thinking_budget !== undefined && job.thinking_budget !== null && (
                <>
                  <dt>Thinking Budget</dt>
                  <dd>{job.thinking_budget}</dd>
                </>
              )}
              
              <dt>Output Mode</dt>
              <dd>{job.output_mode}</dd>
              
              {job.json_schema_file && (
                <>
                  <dt>Schema File</dt>
                  <dd>{job.json_schema_file}</dd>
                </>
              )}
            </dl>
          </div>
        </div>

        <div className="timestamps">
          <span>Created: {formatLongDateTime(job.created_at)}</span>
          <span>Last Updated: {formatLongDateTime(job.updated_at)}</span>
        </div>
      </div>

      {/* Collections Link */}
      <div className="collections-section">
        <h2>Results</h2>
        <p>
          Job output will be saved to a collection once the job completes.
        </p>
        {job.status === "completed" && collections.length > 0 ? (
          <button className="btn-primary" onClick={handleViewCollection}>
            View Collection ({collections.length})
          </button>
        ) : job.status === "completed" ? (
          <button className="btn-secondary" disabled title="No collections yet">
            View Collection (No data)
          </button>
        ) : (
          <p className="info-text">Run the job to generate collection data.</p>
        )}
      </div>
    </div>
  );
}
