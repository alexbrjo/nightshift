import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Collection } from "../database";

interface CollectionsListProps {
  onSelectCollection: (collectionId: number) => void;
}

export default function CollectionsList({ onSelectCollection }: CollectionsListProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadCollections = useCallback(async () => {
    try {
      const data = await invoke<Collection[]>("list_all_collections");
      setCollections(data);
    } catch (error) {
      console.error("Failed to load collections:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (isLoading) {
    return (
      <div className="collections-list">
        <div className="page-header">
          <h1>Collections</h1>
        </div>
        <div className="loading-indicator">Loading collections...</div>
      </div>
    );
  }

  if (collections.length === 0) {
    return (
      <div className="collections-list">
        <div className="page-header">
          <h1>Collections</h1>
        </div>
        <div className="empty-state">
          <p>No collections found.</p>
          <p>Collections are created when inference jobs complete and produce output.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="collections-list">
      <div className="page-header">
        <h1>Collections</h1>
      </div>

      <ul className="collection-list">
        {collections.map((collection) => (
          <li
            key={collection.id}
            className="collection-item"
            onClick={() => onSelectCollection(collection.id)}
          >
            <div className="collection-icon">📁</div>
            <div className="collection-info">
              <div className="collection-name">{collection.name}</div>
              <div className="collection-meta">
                <span className="collection-id">ID: {collection.id}</span>
                <span className="collection-date">{formatDate(collection.created_at)}</span>
                <span className="collection-job">Job #{collection.job_id}</span>
              </div>
            </div>
            <div className="collection-arrow">→</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
