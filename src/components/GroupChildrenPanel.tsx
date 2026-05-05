import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

import type { JobDefinition } from "../database";
import { definitionCreate, definitionListByRoot } from "../api/orchestrator";

interface GroupChildrenPanelProps {
  /** Definition id of the group whose children we're managing. */
  parentDefId: number;
  /** Root id (defaults to parentDefId for the case where the group is itself the root). */
  rootId: number;
  /** Click a child row → navigate to its form. */
  onSelectChild: (defId: number) => void;
  /** Notify parent so it can refresh its sidebar. */
  onChildCreated: () => void;
}

export default function GroupChildrenPanel({
  parentDefId,
  rootId,
  onSelectChild,
  onChildCreated,
}: GroupChildrenPanelProps) {
  const [children, setChildren] = useState<JobDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const all = await definitionListByRoot(rootId);
      setChildren(
        all
          .filter((d) => d.parentId === parentDefId && d.deletedAt === null)
          .sort((a, b) => a.position - b.position || a.id - b.id),
      );
    } catch (e) {
      console.error("Failed to load children:", e);
    } finally {
      setIsLoading(false);
    }
  }, [parentDefId, rootId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const p = listen("definition-updated", () => void load());
    return () => {
      void p.then((fn) => fn());
    };
  }, [load]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const newId = await definitionCreate({
        parentId: parentDefId,
        name: newName.trim(),
        position: children.length,
      });
      setNewName("");
      onChildCreated();
      onSelectChild(newId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [newName, parentDefId, children.length, onChildCreated, onSelectChild]);

  return (
    <section className="group-children-panel">
      <h3>Children</h3>
      {error && <div className="form-error">{error}</div>}
      {isLoading && children.length === 0 ? (
        <div className="loading-indicator">Loading…</div>
      ) : children.length === 0 ? (
        <p className="hint">No children yet. Add one below.</p>
      ) : (
        <ol className="group-children-list">
          {children.map((c) => (
            <li
              key={c.id}
              className={`job-item ${
                c.currentVersionId === null ? "status-pending" : "status-completed"
              }`}
              onClick={() => onSelectChild(c.id)}
            >
              <span className="job-name">{c.name}</span>
              <span className="status-badge">
                {c.currentVersionId === null ? "Unsaved" : `v${c.currentVersionId}`}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="form-row">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="new-child-name"
        />
        <button
          type="button"
          className="btn-secondary"
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
        >
          {creating ? "Adding…" : "+ Add child"}
        </button>
      </div>
    </section>
  );
}
