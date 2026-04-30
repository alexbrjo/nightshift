import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Collection } from "../database";

interface CollectionsListProps {
  selectedId: number | null;
  onSelectCollection: (collectionId: number) => void;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "";
  // SQLite returns "YYYY-MM-DD HH:MM:SS" (no T); some browsers fail to parse it.
  const normalized = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
                  <span>Job {c.job_id}</span>
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
