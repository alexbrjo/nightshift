import { useState } from 'react';
import { Database, Search, Download, Trash2, Filter, Plus, ChevronLeft, ChevronRight } from 'lucide-react';

interface CollectionItem {
  id: string;
  [key: string]: unknown;
}

const mockItems: CollectionItem[] = Array.from({ length: 127 }, (_, i) => ({
  id: `item-${i + 1}`,
  prompt: `Sample prompt #${i + 1}`,
  response: `Generated response content for item ${i + 1}`,
  tokens_used: Math.floor(Math.random() * 4096),
  latency_ms: Math.floor(Math.random() * 5000),
  status: i % 10 === 0 ? 'error' : 'success',
}));

const PAGE_SIZE = 50;

export default function CollectionsView() {
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  const filteredItems = mockItems.filter(item =>
    Object.values(item).some(v =>
      String(v).toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  const totalPages = Math.ceil(filteredItems.length / PAGE_SIZE);
  const paginatedItems = filteredItems.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  function toggleSelect(id: string) {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (selectedItems.size === paginatedItems.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(paginatedItems.map(i => i.id)));
    }
  }

  function handleExport(format: 'jsonl' | 'csv') {
    const itemsToExport = selectedItems.size > 0
      ? mockItems.filter(item => selectedItems.has(item.id))
      : filteredItems;

    console.log(`Exporting ${itemsToExport.length} items as ${format}`);
    // In production: invoke export_to_jsonl or export_to_csv Tauri command
  }

  function handleDelete() {
    if (selectedItems.size === 0) return;
    console.log('Deleting', selectedItems.size, 'items');
    setSelectedItems(new Set());
  }

  const columns = Object.keys(mockItems[0] || {}).filter(k => k !== 'id');

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Database className="w-5 h-5" />
          Collections
        </h1>

        <div className="flex items-center gap-2">
          {selectedItems.size > 0 && (
            <>
              <span className="text-sm text-text-muted">{selectedItems.size} selected</span>
              <button
                onClick={handleDelete}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-error/10 text-error hover:bg-error/20 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </>
          )}

          <div className="relative">
            <Download className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <select
              onChange={(e) => handleExport(e.target.value as 'jsonl' | 'csv')}
              className="pl-8 pr-6 py-1.5 bg-bg-secondary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent appearance-none"
            >
              <option value="">Export...</option>
              <option value="jsonl">JSONL</option>
              <option value="csv">CSV</option>
            </select>
          </div>

          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-accent hover:bg-accent-hover text-white transition-colors">
            <Plus className="w-3.5 h-3.5" />
            New Collection
          </button>
        </div>
      </div>

      {/* Search & Filter */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            placeholder="Search items..."
            className="w-full pl-8 pr-3 py-2 bg-bg-secondary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>

        <button className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-bg-hover transition-colors">
          <Filter className="w-4 h-4" />
          Filter
        </button>
      </div>

      {/* Table */}
      <div className="bg-bg-secondary rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-3 py-2.5 w-10">
                  <input
                    type="checkbox"
                    checked={selectedItems.size === paginatedItems.length && paginatedItems.length > 0}
                    onChange={selectAll}
                    className="rounded border-border bg-bg-primary text-accent focus:ring-accent"
                  />
                </th>
                {columns.map(col => (
                  <th key={col} className="px-3 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
                    {col.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginatedItems.map(item => (
                <tr key={item.id} className="border-b border-border hover:bg-bg-hover transition-colors">
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={selectedItems.has(item.id as string)}
                      onChange={() => toggleSelect(item.id as string)}
                      className="rounded border-border bg-bg-primary text-accent focus:ring-accent"
                    />
                  </td>
                  {columns.map(col => (
                    <td key={`${item.id}-${col}`} className="px-3 py-2.5">
                      {col === 'status' ? (
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                          item[col] === 'success' || item[col] === 'error'
                            ? item[col] === 'success' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
                            : 'bg-bg-hover text-text-muted'
                        }`}>
                          {String(item[col])}
                        </span>
                      ) : col === 'tokens_used' || col === 'latency_ms' ? (
                        <span className="font-mono text-text-secondary">{String(item[col])}</span>
                      ) : (
                        <span className="text-text-secondary truncate block max-w-[200px]">
                          {String(item[col])}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}

              {paginatedItems.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="px-3 py-8 text-center text-text-muted">
                    No items found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-3 py-2.5 border-t border-border bg-bg-tertiary">
          <span className="text-xs text-text-muted">
            Showing {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, filteredItems.length)} of {filteredItems.length}
          </span>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-1 rounded hover:bg-bg-hover text-text-muted disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let page: number;
              if (totalPages <= 5) {
                page = i + 1;
              } else if (currentPage <= 3) {
                page = i + 1;
              } else if (currentPage >= totalPages - 2) {
                page = totalPages - 4 + i;
              } else {
                page = currentPage - 2 + i;
              }

              return (
                <button
                  key={page}
                  onClick={() => setCurrentPage(page)}
                  className={`w-7 h-7 rounded text-xs font-medium transition-colors ${
                    page === currentPage
                      ? 'bg-accent-dim text-accent'
                      : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  {page}
                </button>
              );
            })}

            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="p-1 rounded hover:bg-bg-hover text-text-muted disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
