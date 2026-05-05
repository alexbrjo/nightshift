import { useState, useCallback, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import type { JobDefinition } from "../database";
import { useActiveRefresh } from "../hooks/useActiveRefresh";
import { formatRelativeTime } from "../utils/date";
import { definitionListRoots } from "../api/orchestrator";

interface DefinitionListSidebarProps {
  selectedId?: number | null;
  onSelectDefinition: (defId: number) => void;
  onNewDefinition: () => void;
  refreshKey?: number;
  isActive?: boolean;
}

function kindLabel(kind: string | null): string {
  switch (kind) {
    case "inference":
      return "Inference";
    case "group":
      return "Group";
    case "analysis":
      return "Analysis";
    case "js_action":
      return "JS Action";
    default:
      return "Unsaved";
  }
}

/**
 * Until version-pinning lands in checkpoint 4, the sidebar shows the saved-vs-
 * unsaved state in the badge slot. Once executions exist we layer their
 * status badges on top.
 */
function savedClass(currentVersionId: number | null): string {
  return currentVersionId === null ? "status-pending" : "status-completed";
}

export default function DefinitionListSidebar({
  selectedId = null,
  onSelectDefinition,
  onNewDefinition,
  refreshKey = 0,
  isActive = true,
}: DefinitionListSidebarProps) {
  const [definitions, setDefinitions] = useState<JobDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!hasLoadedRef.current) setIsLoading(true);
    try {
      const list = await definitionListRoots();
      setDefinitions(Array.isArray(list) ? list : []);
      hasLoadedRef.current = true;
    } catch (error) {
      console.error("Failed to load definitions:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useActiveRefresh({ isActive, refresh: load, intervalMs: 5000, refreshToken: refreshKey });

  // Live refresh on backend mutations so the sidebar updates without waiting
  // for the next 5s poll. `definition-version-created` fires on first save,
  // `definition-updated` on rename/move/delete.
  useEffect(() => {
    if (!isActive) return;
    const unlisteners: Array<Promise<() => void>> = [
      listen("definition-version-created", () => void load()),
      listen("definition-updated", () => void load()),
    ];
    return () => {
      unlisteners.forEach((p) => void p.then((fn) => fn()));
    };
  }, [isActive, load]);

  return (
    <aside className="job-list-sidebar">
      <header className="job-list-header">
        <h2>Experiments</h2>
        <button className="btn-primary btn-small" onClick={onNewDefinition}>
          + New
        </button>
      </header>

      {isLoading ? (
        <div className="loading-indicator">Loading…</div>
      ) : definitions.length === 0 ? (
        <div className="job-list-empty">
          <p>No experiments yet.</p>
          <button className="btn-secondary btn-small" onClick={onNewDefinition}>
            Create your first experiment
          </button>
        </div>
      ) : (
        <ul className="job-list">
          {definitions.map((def) => {
            const date = formatRelativeTime(def.updatedAt);
            const cls = savedClass(def.currentVersionId);
            // We don't carry the version's kind in JobDefinition; until we add
            // it server-side, fall back to "Inference" since that's the only
            // kind the v1 form lets the user create. Group/analysis/js_action
            // arrive in checkpoint 6 and will need the kind on the row.
            const kind = def.currentVersionId === null ? null : "inference";
            return (
              <li
                key={def.id}
                className={`job-item ${cls}${selectedId === def.id ? " selected" : ""}`}
                onClick={() => onSelectDefinition(def.id)}
              >
                <div className="job-primary-line">
                  <div className="job-name">{def.name}</div>
                  <span className={`status-badge ${cls}`}>
                    {def.currentVersionId === null ? "Unsaved" : `v${def.currentVersionId}`}
                  </span>
                </div>
                <div className="job-meta">
                  <span className="job-type-badge">{kindLabel(kind)}</span>
                  {date && <span className="job-relative-time">{date}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
