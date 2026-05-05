import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

import type { JobDefinitionVersion } from "../database";
import { definitionListVersions } from "../api/orchestrator";
import { formatRelativeTime } from "../utils/date";

interface DefinitionHistoryPanelProps {
  defId: number | null;
  /** Highlights the current HEAD so the user can see which version is live. */
  currentVersionId: number | null;
  /** Called when the user clicks a version row to inspect its content. */
  onViewVersion?: (versionId: number) => void;
}

export default function DefinitionHistoryPanel({
  defId,
  currentVersionId,
  onViewVersion,
}: DefinitionHistoryPanelProps) {
  const [versions, setVersions] = useState<JobDefinitionVersion[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (defId === null) {
      setVersions([]);
      return;
    }
    setIsLoading(true);
    try {
      const list = await definitionListVersions(defId);
      setVersions(list);
    } catch (error) {
      console.error("Failed to load version history:", error);
      setVersions([]);
    } finally {
      setIsLoading(false);
    }
  }, [defId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (defId === null) return;
    const p = listen<{ defId: number }>("definition-version-created", (event) => {
      if (event.payload.defId === defId) void load();
    });
    return () => {
      void p.then((fn) => fn());
    };
  }, [defId, load]);

  if (defId === null) return null;

  return (
    <section className="definition-history-panel">
      <h3>History</h3>
      {isLoading && versions.length === 0 ? (
        <div className="loading-indicator">Loading…</div>
      ) : versions.length === 0 ? (
        <p className="hint">No saved versions yet. Save the form to create v1.</p>
      ) : (
        <ol className="definition-history-list">
          {versions.map((v, idx) => (
            <li
              key={v.id}
              className={`definition-history-item${
                v.id === currentVersionId ? " head" : ""
              }`}
              onClick={() => onViewVersion?.(v.id)}
            >
              <span className="definition-history-rev">v{idx + 1}</span>
              <span className="definition-history-meta">
                <span className="definition-history-author">{v.createdBy}</span>
                <span className="definition-history-time">
                  {formatRelativeTime(v.createdAt)}
                </span>
              </span>
              {v.message && (
                <span className="definition-history-message">{v.message}</span>
              )}
              {v.id === currentVersionId && (
                <span className="status-badge status-completed">HEAD</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
