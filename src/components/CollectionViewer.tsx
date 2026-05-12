import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CollectionItem } from "../database";

interface CollectionViewerProps {
  collectionId: number;
  collectionName?: string;
  onBack?: () => void;
}

type FlatRecord = Record<string, unknown>;

interface FlatItem {
  id: number;
  flat: FlatRecord;
}

const CELL_TRUNCATE_LENGTH = 80;

// LLM outputs are often `{...}` or wrapped in ```json fences. Extract JSON if possible.
function tryParseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    // not JSON
  }
  return null;
}

function flattenItem(item: CollectionItem): FlatItem {
  const data = item.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { id: item.id, flat: { value: data } };
  }
  const record = data as FlatRecord;
  const inner = tryParseEmbeddedJson(record.content);
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const { content: _content, ...rest } = record;
    return { id: item.id, flat: { ...(inner as FlatRecord), ...rest } };
  }
  if (inner !== null) {
    const { content: _content, ...rest } = record;
    return { id: item.id, flat: { value: inner, ...rest } };
  }
  return { id: item.id, flat: Object.keys(record).length > 0 ? record : { value: data } };
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatExpanded(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export default function CollectionViewer({ collectionId, collectionName, onBack }: CollectionViewerProps) {
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(25);
  const [isLoading, setIsLoading] = useState(true);
  const [searchFilter, setSearchFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const loadItems = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [itemsData, count] = await Promise.all([
        invoke<CollectionItem[]>("get_collection_items", {
          collectionId,
          page: currentPage,
          pageSize,
        }),
        invoke<number>("get_collection_count", { collectionId }),
      ]);

      setItems(Array.isArray(itemsData) ? itemsData : []);
      setTotalItems(typeof count === "number" ? count : 0);
      setExpandedIds(new Set());
    } catch (err) {
      console.error("Failed to load collection items:", err);
      setError(err instanceof Error ? err.message : "Failed to load items");
    } finally {
      setIsLoading(false);
    }
  }, [collectionId, currentPage, pageSize]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const flatItems = useMemo(() => items.map(flattenItem), [items]);

  const columnKeys = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const { flat } of flatItems) {
      for (const key of Object.keys(flat)) {
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(key);
        }
      }
    }
    return ordered;
  }, [flatItems]);

  const filteredItems = useMemo(() => {
    if (!searchFilter.trim()) return flatItems;
    const term = searchFilter.toLowerCase();
    return flatItems.filter(({ flat }) =>
      Object.values(flat).some((v) => formatCell(v).toLowerCase().includes(term)),
    );
  }, [flatItems, searchFilter]);

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteItem = async (itemId: number) => {
    if (!confirm("Are you sure you want to delete this item?")) return;
    try {
      const deleted = await invoke<boolean>("delete_collection_item", { itemId });
      if (deleted) await loadItems();
      else alert("Failed to delete item");
    } catch (err) {
      console.error("Failed to delete item:", err);
      alert(err instanceof Error ? err.message : "Failed to delete item");
    }
  };

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportJSONL = async () => {
    try {
      const content = await invoke<string>("export_collection_jsonl", { collectionId });
      downloadFile(content, `collection_${collectionId}.jsonl`, "application/jsonl");
    } catch (err) {
      console.error("Failed to export JSONL:", err);
      alert(err instanceof Error ? err.message : "Failed to export collection");
    }
  };

  const handleExportCSV = async () => {
    try {
      const content = await invoke<string>("export_collection_csv", { collectionId });
      downloadFile(content, `collection_${collectionId}.csv`, "text/csv");
    } catch (err) {
      console.error("Failed to export CSV:", err);
      alert(err instanceof Error ? err.message : "Failed to export collection");
    }
  };

  const totalPages = Math.ceil(totalItems / pageSize);

  if (isLoading && items.length === 0) {
    return (
      <div className="collection-viewer">
        <div className="loading-indicator">Loading collection...</div>
      </div>
    );
  }

  return (
    <div className="collection-viewer">
      <div className="page-header">
        {onBack && (
          <button className="btn-secondary" onClick={onBack}>
            ← Back
          </button>
        )}
        <h1>{collectionName?.trim() || `Collection #${collectionId}`}</h1>
        <div className="header-actions">
          <button className="btn-secondary" onClick={handleExportJSONL}>
            Export JSONL
          </button>
          <button className="btn-secondary" onClick={handleExportCSV}>
            Export CSV
          </button>
        </div>
      </div>

      <div className="collection-toolbar">
        <input
          type="text"
          placeholder="Search items..."
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          className="search-input"
        />
        <div className="collection-stats">
          <span>Total: {totalItems}</span>
          <span>Showing: {filteredItems.length}</span>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      {items.length === 0 ? (
        <div className="empty-state">
          <p>No items in this collection.</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="empty-state">
          <p>No matching items.</p>
        </div>
      ) : (
        <>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-id">ID</th>
                  {columnKeys.map((key) => (
                    <th key={key}>{key}</th>
                  ))}
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map(({ id, flat }) => {
                  const isExpanded = expandedIds.has(id);
                  return (
                    <Fragment key={id}>
                      <tr
                        className={`data-row${isExpanded ? " expanded" : ""}`}
                        onClick={() => toggleExpanded(id)}
                      >
                        <td className="col-id">{id}</td>
                        {columnKeys.map((key) => {
                          const cell = formatCell(flat[key]);
                          return (
                            <td key={key} title={cell}>
                              {cell.length > CELL_TRUNCATE_LENGTH
                                ? `${cell.slice(0, CELL_TRUNCATE_LENGTH)}…`
                                : cell}
                            </td>
                          );
                        })}
                        <td
                          className="col-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="btn-danger btn-small"
                            onClick={() => handleDeleteItem(id)}
                            title="Delete item"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="data-row-detail">
                          <td colSpan={columnKeys.length + 2}>
                            <dl className="detail-list">
                              {columnKeys.map((key) => (
                                <div className="detail-row" key={key}>
                                  <dt>{key}</dt>
                                  <dd>
                                    <pre>{formatExpanded(flat[key])}</pre>
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn-secondary"
                onClick={() => setCurrentPage((p) => p - 1)}
                disabled={currentPage === 1}
              >
                Previous
              </button>
              <span className="page-info">
                Page {currentPage} of {totalPages}
              </span>
              <button
                className="btn-secondary"
                onClick={() => setCurrentPage((p) => p + 1)}
                disabled={currentPage === totalPages}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
