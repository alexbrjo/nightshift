import React, { useState, useEffect } from 'react';
import { api } from '../api';
import type { ProjectFile, Collection } from '@shared/types';

export default function ActionPanel() {
  const [sourceCollection, setSourceCollection] = useState('');
  const [scriptPath, setScriptPath] = useState('');
  const [targetCollection, setTargetCollection] = useState('');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.getCollections().then(res => setCollections((res.collections as Collection[]) || [])).catch(() => {});
    api.getFiles('').then(res => setFiles(res.files)).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.runAction({ sourceCollection, scriptPath, targetCollection });
      setMessage(`Action started: ${res.id}`);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run action');
      setMessage('');
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Run Action</h1>
      {message && <div className="p-3 bg-green-900/20 text-green-400 rounded text-sm">{message}</div>}
      {error && <div className="p-3 bg-red-900/20 text-red-400 rounded text-sm">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4 bg-gray-800 p-4 rounded border border-gray-700">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Source Collection</label>
          <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={sourceCollection} onChange={e => setSourceCollection(e.target.value)} required>
            <option value="">Select collection...</option>
            {collections.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Script File</label>
          <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={scriptPath} onChange={e => setScriptPath(e.target.value)} required>
            <option value="">Select file...</option>
            {files.filter(f => !f.isDirectory).map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Target Collection Name</label>
          <input className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={targetCollection} onChange={e => setTargetCollection(e.target.value)} required />
        </div>
        <button type="submit" className="px-4 py-2 bg-blue-600 rounded text-sm font-medium hover:bg-blue-500">Run Action</button>
      </form>
    </div>
  );
}
