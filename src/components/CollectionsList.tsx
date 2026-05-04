import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Collection } from "../database";
import { useActiveRefresh } from "../hooks/useActiveRefresh";
import { formatDate } from "../utils/date";

interface CollectionsListProps {
  isActive?: boolean;
  selectedId: number | null;
  onSelectCollection: (collectionId: number) => void;
}

export default function CollectionsList({
  isActive = true,
  selectedId,
  onSelectCollection,
}: CollectionsListProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadCollections = useCallback(async () => {
    if (!hasLoadedRef.current) setIsLoading(true);
    setError(null);
    try {
      const data = await invoke<Collection[]>("list_all_collections");
      setCollections(Array.isArray(data) ? data : []);
      hasLoadedRef.current = true;
    } catch (error) {
      console.error("Failed to load collections:", error);
      setError(error instanceof Error ? error.message : "Failed to load collections");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setupCollectionRefresh = useCallback(async () => {
    const unlistens = await Promise.all([
      listen("job-started", () => loadCollections()),
      listen("job-completed", () => loadCollections()),
      listen("job-cancelled", () => loadCollections()),
      listen("job-failed", () => loadCollections()),
    ]);
    return () => unlistens.forEach((unlisten) => unlisten());
  }, [loadCollections]);

  useActiveRefresh({
    isActive,
    refresh: loadCollections,
    setup: setupCollectionRefresh,
  });

  return (
    <aside className="collections-sidebar">
      <header className="collections-sidebar-header">
        <h2>Collections</h2>
        <span className="collections-count">{collections.length}</span>
      </header>

      {error && (
        <div className="collections-empty">
          <p>{error}</p>
          <button type="button" className="btn-secondary btn-small" onClick={loadCollections}>
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="loading-indicator">Loading…</div>
      ) : error ? null : collections.length === 0 ? (
        <div className="collections-empty">
          <p>No collections yet.</p>
          <p>Run an inference job to generate one.</p>
        </div>
      ) : (
        <ul className="collection-list">
          {collections.map((c) => {
            const date = formatDate(c.created_at);
            return (
              <li
                key={c.id}
                className={`collection-item${selectedId === c.id ? " selected" : ""}`}
                onClick={() => onSelectCollection(c.id)}
              >
                <div className="collection-name">{c.name}</div>
                <div className="collection-meta">
                  <span>#{c.id}</span>
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
