import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Collection } from '@shared/types';

export default function CollectionsList() {
  const navigate = useNavigate();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getCollections()
      .then(res => setCollections((res.collections as Collection[]) || []))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load collections'));
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Collections</h1>
      {error && <div className="p-3 bg-red-900/20 text-red-400 rounded text-sm mb-4">{error}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {collections.map(c => (
          <div key={c.id} onClick={() => navigate(`/collections/${c.name}`)} className="p-4 bg-gray-800 rounded border border-gray-700 cursor-pointer hover:border-gray-500">
            <div className="font-medium">{c.name}</div>
            <div className="text-xs text-gray-500 mt-1">{new Date(c.createdAt).toLocaleString()}</div>
          </div>
        ))}
        {collections.length === 0 && <div className="text-gray-500 text-sm">No collections found.</div>}
      </div>
    </div>
  );
}
