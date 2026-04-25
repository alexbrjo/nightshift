import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { CollectionItem } from '@shared/types';

const PER_PAGE = 50;

export default function CollectionView() {
  const { name } = useParams<{ name: string }>();
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const fetchPage = async (p: number, s: string) => {
    if (!name) return;
    try {
      const res = await api.getCollection(name, p, s);
      setItems((res.items as CollectionItem[]) || []);
      setColumns(res.columns || []);
      setTotal(res.total || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load collection');
    }
  };

  useEffect(() => {
    if (!name) return;
    setPage(1);
    fetchPage(1, search);
  }, [name, search]);

  useEffect(() => {
    if (!name) return;
    fetchPage(page, search);
  }, [page, name]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchPage(1, search);
  };

  const exportFile = async (format: 'jsonl' | 'csv') => {
    if (!name) return;
    const res = await api.exportCollection(name, format);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.${format === 'jsonl' ? 'jsonl' : 'csv'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (id: string) => {
    if (!name || !window.confirm('Delete this item?')) return;
    try {
      await api.deleteCollectionItem(name, id);
      fetchPage(page, search);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  if (!name) return <div className="p-6">Invalid collection name</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{name}</h1>
        <div className="flex gap-2">
          <button onClick={() => exportFile('jsonl')} className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600">Export JSONL</button>
          <button onClick={() => exportFile('csv')} className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600">Export CSV</button>
        </div>
      </div>
      {error && <div className="p-3 bg-red-900/20 text-red-400 rounded text-sm">{error}</div>}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search..."
          className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
        />
        <button type="submit" className="px-3 py-2 bg-blue-600 rounded text-sm hover:bg-blue-500">Search</button>
      </form>

      {items.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">No items found.</div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm border border-gray-700 rounded">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                {columns.map(col => <th key={col} className="text-left px-3 py-2">{col}</th>)}
                <th className="text-left px-3 py-2 w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-gray-800">
                  {columns.map(col => (
                    <td key={col} className="px-3 py-2 text-xs">
                      {typeof item.data[col] === 'string' ? item.data[col] as string : JSON.stringify(item.data[col])}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <button onClick={() => handleDelete(item.id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm">
        <div className="text-gray-400">Page {page} of {totalPages} ({total} items)</div>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600">Prev</button>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600">Next</button>
        </div>
      </div>
    </div>
  );
}
