import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Job, JobConfig, ProjectFile, Collection } from '@shared/types';

export default function JobPanel() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState('');
  const [dataSource, setDataSource] = useState<'file' | 'collection'>('file');

  const [config, setConfig] = useState<JobConfig>({
    name: '',
    samples: 1,
    strategy: 'single',
    templatePath: '',
    dataPath: '',
    dataCollection: '',
    host: '',
    model: '',
    outputMode: 'unstructured',
    schemaPath: '',
    temperature: 0.7,
    maxTokens: 1024,
    thinkingBudget: 0,
    preRenderUrl: '',
    preRenderJson: '',
  });

  useEffect(() => {
    api.getJobs().then(res => setJobs((res.jobs as Job[]) || [])).catch(e => setError(e.message));
    api.getFiles('').then(res => setFiles(res.files)).catch(() => {});
    api.getCollections().then(res => setCollections((res.collections as Collection[]) || [])).catch(() => {});
  }, []);

  const update = (field: keyof JobConfig, value: unknown) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload: Partial<JobConfig> = {
        name: config.name,
        samples: config.samples,
        strategy: config.strategy,
        templatePath: config.templatePath,
        host: config.host,
        model: config.model,
        outputMode: config.outputMode,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        thinkingBudget: config.thinkingBudget || undefined,
        preRenderUrl: config.preRenderUrl || undefined,
        preRenderJson: config.preRenderJson || undefined,
        ...(dataSource === 'file' ? { dataPath: config.dataPath || undefined } : { dataCollection: config.dataCollection || undefined }),
        ...(config.outputMode === 'schema' ? { schemaPath: config.schemaPath || undefined } : {}),
      };
      const res = await api.createJob(payload);
      navigate(`/jobs/${res.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create job');
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold">Create Job</h1>
      {error && <div className="p-3 bg-red-900/20 text-red-400 rounded text-sm">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4 bg-gray-800 p-4 rounded border border-gray-700">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.name} onChange={e => update('name', e.target.value)} required />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Samples</label>
            <input type="number" className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.samples} onChange={e => update('samples', Number(e.target.value))} min={1} required />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Strategy</label>
            <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.strategy} onChange={e => update('strategy', e.target.value)}>
              <option value="single">single</option>
              <option value="random">random</option>
              <option value="exhaustive">exhaustive</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Template File</label>
            <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.templatePath} onChange={e => update('templatePath', e.target.value)} required>
              <option value="">Select file...</option>
              {files.filter(f => !f.isDirectory).map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-400 mb-1">Data Source</label>
            <div className="flex gap-4 mb-2">
              <label className="flex items-center gap-1 text-sm">
                <input type="radio" checked={dataSource === 'file'} onChange={() => setDataSource('file')} />
                File
              </label>
              <label className="flex items-center gap-1 text-sm">
                <input type="radio" checked={dataSource === 'collection'} onChange={() => setDataSource('collection')} />
                Collection
              </label>
            </div>
            {dataSource === 'file' ? (
              <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.dataPath || ''} onChange={e => update('dataPath', e.target.value || undefined)}>
                <option value="">Select file...</option>
                {files.filter(f => !f.isDirectory).map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
              </select>
            ) : (
              <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.dataCollection || ''} onChange={e => update('dataCollection', e.target.value || undefined)}>
                <option value="">Select collection...</option>
                {collections.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Host</label>
            <input className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.host} onChange={e => update('host', e.target.value)} required />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Model</label>
            <input className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.model} onChange={e => update('model', e.target.value)} required />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Output Mode</label>
            <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.outputMode} onChange={e => update('outputMode', e.target.value)}>
              <option value="unstructured">unstructured</option>
              <option value="json">json</option>
              <option value="schema">schema</option>
            </select>
          </div>
          {config.outputMode === 'schema' && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Schema File</label>
              <select className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.schemaPath || ''} onChange={e => update('schemaPath', e.target.value || undefined)}>
                <option value="">Select file...</option>
                {files.filter(f => !f.isDirectory).map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Temperature</label>
            <input type="number" step="0.1" className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.temperature} onChange={e => update('temperature', Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Max Tokens</label>
            <input type="number" className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.maxTokens} onChange={e => update('maxTokens', Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Thinking Budget</label>
            <input type="number" className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.thinkingBudget || 0} onChange={e => update('thinkingBudget', Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Pre-render URL</label>
            <input className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm" value={config.preRenderUrl || ''} onChange={e => update('preRenderUrl', e.target.value || undefined)} />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Pre-render JSON</label>
          <textarea className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm h-20" value={config.preRenderJson || ''} onChange={e => update('preRenderJson', e.target.value || undefined)} />
        </div>
        <button type="submit" className="px-4 py-2 bg-blue-600 rounded text-sm font-medium hover:bg-blue-500">Create Job</button>
      </form>

      <div>
        <h2 className="text-xl font-bold mb-4">Existing Jobs</h2>
        <div className="space-y-2">
          {jobs.map(job => (
            <div key={job.id} onClick={() => navigate(`/jobs/${job.id}`)} className="p-3 bg-gray-800 rounded border border-gray-700 cursor-pointer hover:bg-gray-750 hover:border-gray-600">
              <div className="flex items-center justify-between">
                <span className="font-medium">{job.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${job.status === 'completed' ? 'bg-green-900/30 text-green-400' : job.status === 'error' ? 'bg-red-900/30 text-red-400' : job.status === 'running' ? 'bg-blue-900/30 text-blue-400' : 'bg-gray-700 text-gray-400'}`}>
                  {job.status}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{new Date(job.createdAt).toLocaleString()}</div>
            </div>
          ))}
          {jobs.length === 0 && <div className="text-gray-500 text-sm">No jobs yet.</div>}
        </div>
      </div>
    </div>
  );
}
