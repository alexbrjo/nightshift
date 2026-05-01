import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Collection } from "../database";
import { formatDate } from "../utils/date";

interface CollectionsListProps {
  selectedId: number | null;
  onSelectCollection: (collectionId: number) => void;
}

export default function CollectionsList({ selectedId, onSelectCollection }: CollectionsListProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadCollections = useCallback(async () => {
    try {
      const data = await invoke<Collection[]>("list_all_collections");
      setCollections(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Failed to load collections:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCollections();

    // Refresh when any job emits a terminal event — that's when new collections
    // appear (or a partial collection's item count grows). job-started also
    // matters because the executor creates the empty collection eagerly.
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    (async () => {
      try {
        const fns = await Promise.all([
          listen("job-started", () => loadCollections()),
          listen("job-completed", () => loadCollections()),
          listen("job-cancelled", () => loadCollections()),
          listen("job-failed", () => loadCollections()),
        ]);
        if (cancelled) {
          fns.forEach((fn) => fn());
        } else {
          unlistens.push(...fns);
        }
      } catch (err) {
        console.error("Failed to register collection list listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
  }, [loadCollections]);

  return (
    <aside className="collections-sidebar">
      <header className="collections-sidebar-header">
        <h2>Collections</h2>
        <span className="collections-count">{collections.length}</span>
      </header>

      {isLoading ? (
        <div className="loading-indicator">Loading…</div>
      ) : collections.length === 0 ? (
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
