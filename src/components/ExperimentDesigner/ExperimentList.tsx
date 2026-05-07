import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ExperimentSummary } from "../../utils/experimentSchema";

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  refreshKey: number;
}

function isNoProjectError(msg: string): boolean {
  return /no project folder is open/i.test(msg);
}

export default function ExperimentList({ selectedId, onSelect, onNew, refreshKey }: Props) {
  const [items, setItems] = useState<ExperimentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [needsProject, setNeedsProject] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await invoke<ExperimentSummary[]>("list_experiments");
      setItems(list);
      setError(null);
      setNeedsProject(false);
    } catch (e) {
      const msg = String(e);
      if (isNoProjectError(msg)) {
        // Expected before FileTree's project-opened event lands. Don't show
        // the raw backend error; show a friendly hint and clear it once the
        // event fires (handled by the listener below).
        setNeedsProject(true);
        setError(null);
        setItems([]);
      } else {
        setError(msg);
        setNeedsProject(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const unlistenPromise = listen("project-opened", () => {
      void load();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [load, refreshKey]);

  return (
    <div className="experiment-list">
      <h3>Experiments</h3>
      <button type="button" className="experiment-list-new" onClick={onNew}>
        + New experiment
      </button>
      {error ? <div className="planner-error">{error}</div> : null}
      {needsProject ? (
        <div className="experiment-list-empty">Open a project folder to view experiments.</div>
      ) : null}
      {!needsProject && items.length === 0 && !error ? (
        <div className="experiment-list-empty">No saved experiments yet.</div>
      ) : null}
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`experiment-list-item${selectedId === it.id ? " active" : ""}`}
          onClick={() => onSelect(it.id)}
          title={it.bundle_path}
        >
          <div>{it.id}</div>
          <div className="meta">
            IV: {it.independent_variable_name} • {it.created_at.slice(0, 10)}
          </div>
        </button>
      ))}
    </div>
  );
}
