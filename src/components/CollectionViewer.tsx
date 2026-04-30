import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CollectionItem } from "../database";

interface CollectionViewerProps {
  collectionId: number;
  onBack?: () => void;
}

interface ColumnConfig {
  key: string;
  label: string;
}

export default function CollectionViewer({ collectionId, onBack }: CollectionViewerProps) {
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(25);
  const [isLoading, setIsLoading] = useState(true);
  const [searchFilter, setSearchFilter] = useState("");
  const [columns, setColumns] = useState<ColumnConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Detect columns from items
  const detectColumns = useCallback((itemsData: CollectionItem[]) => {
    if (itemsData.length === 0) {
      setColumns([]);
      return;
    }

    // Collect all unique keys from all items
    const keySet = new Set<string>();
    itemsData.forEach((item) => {
      if (typeof item.data === "object" && item.data !== null) {
        Object.keys(item.data).forEach((key) => keySet.add(key));
      }
    });

    // Convert to column configs, sorted alphabetically
    const newColumns: ColumnConfig[] = Array.from(keySet)
      .sort()
      .map((key) => ({ key, label: key }));

    setColumns(newColumns);
  }, []);

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

      setItems(itemsData);
      setTotalItems(count);
      detectColumns(itemsData);
    } catch (err) {
      console.error("Failed to load collection items:", err);
      setError(err instanceof Error ? err.message : "Failed to load items");
    } finally {
      setIsLoading(false);
    }
  }, [collectionId, currentPage, pageSize, detectColumns]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const handleDeleteItem = async (itemId: number) => {
    if (!confirm("Are you sure you want to delete this item?")) {
      return;
    }

    try {
      const deleted = await invoke<boolean>("delete_collection_item", { itemId });
      if (deleted) {
        // Reload items
        await loadItems();
      } else {
        alert("Failed to delete item");
      }
    } catch (err) {
      console.error("Failed to delete item:", err);
      alert(err instanceof Error ? err.message : "Failed to delete item");
    }
  };

  const handleExportJSONL = async () => {
    try {
      const jsonlContent = await invoke<string>("export_collection_jsonl", { collectionId });

      // Create download link
      const blob = new Blob([jsonlContent], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `collection_${collectionId}.jsonl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export JSONL:", err);
      alert(err instanceof Error ? err.message : "Failed to export collection");
    }
  };

  const handleExportCSV = async () => {
    try {
      const csvContent = await invoke<string>("export_collection_csv", { collectionId });

      // Create download link
      const blob = new Blob([csvContent], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `collection_${collectionId}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export CSV:", err);
      alert(err instanceof Error ? err.message : "Failed to export collection");
    }
  };

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  const totalPages = Math.ceil(totalItems / pageSize);

  // Filter items based on search
  const filteredItems = items.filter((item) => {
    if (!searchFilter.trim()) return true;
    const searchTerm = searchFilter.toLowerCase();

    // Search in all values of the item data
    if (typeof item.data === "object" && item.data !== null) {
      return Object.values(item.data).some((value) => {
        const stringValue = String(value).toLowerCase();
        return stringValue.includes(searchTerm);
      });
    }
    return false;
  });

  // Format value for display in table cell
  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  };

  // Truncate long values for display
  const truncateValue = (value: string, maxLength: number = 100): string => {
    if (value.length <= maxLength) return value;
    return value.substring(0, maxLength) + "...";
  };

  if (isLoading && items.length === 0) {
    return (
      <div className="collection-viewer">
        <div className="loading-indicator">Loading collection...</div>
      </div>
    );
  }

  return (
    <div className="collection-viewer">
      {/* Header */}
      <div className="page-header">
        {onBack && (
          <button className="btn-secondary" onClick={onBack}>
            ← Back
          </button>
        )}
        <h1>Collection #{collectionId}</h1>
        <div className="header-actions">
          <button className="btn-secondary" onClick={handleExportJSONL}>
            📥 Export JSONL
          </button>
          <button className="btn-secondary" onClick={handleExportCSV}>
            📥 Export CSV
          </button>
        </div>
      </div>

      {/* Search and Stats */}
      <div className="collection-toolbar">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search items..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="search-input"
          />
        </div>
        <div className="collection-stats">
          <span>Total: {totalItems} items</span>
          <span>Showing: {filteredItems.length} items</span>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="error-message">{error}</div>
      )}

      {/* Data Table */}
      {columns.length === 0 ? (
        <div className="empty-state">
          <p>No items in this collection.</p>
        </div>
      ) : (
        <>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-id">ID</th>
                  {columns.map((column) => (
                    <th key={column.key} className={`col-${column.key.replace(/\s+/g, "-")}`}>
                      {column.label}
                    </th>
                  ))}
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.id}>
                    <td className="col-id">{item.id}</td>
                    {columns.map((column) => {
                      const value =
                        typeof item.data === "object" && item.data !== null
                          ? (item.data as Record<string, unknown>)[column.key]
                          : undefined;
                      const formattedValue = formatCellValue(value);
                      return (
                        <td key={column.key} className={`col-${column.key.replace(/\s+/g, "-")}`}>
                          {truncateValue(formattedValue)}
                        </td>
                      );
                    })}
                    <td className="col-actions">
                      <button
                        className="btn-danger btn-small"
                        onClick={() => handleDeleteItem(item.id)}
                        title="Delete item"
                      >
                        🗑️
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn-secondary"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
              >
                ← Previous
              </button>
              <span className="page-info">
                Page {currentPage} of {totalPages}
              </span>
              <button
                className="btn-secondary"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === totalPages}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
