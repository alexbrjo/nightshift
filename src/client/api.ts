const BASE = '/api';

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Project
  getFiles: (dir?: string) => fetchJson<{ files: { path: string; name: string; isDirectory: boolean }[] }>(`/project/files?dir=${encodeURIComponent(dir || '')}`),
  readFile: (path: string) => fetchJson<{ content: string }>(`/project/file?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) => fetchJson<void>(`/project/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content }) }),
  deleteFile: (path: string) => fetchJson<void>(`/project/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  getProject: () => fetchJson<{ path: string }>('/project'),
  openProject: (path: string) => fetchJson<{ path: string }>(`/project/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }),

  // Jobs
  getJobs: () => fetchJson<{ jobs: unknown[] }>('/jobs'),
  getJob: (id: string) => fetchJson<{ job: unknown }>(`/jobs/${id}`),
  createJob: (config: unknown) => fetchJson<{ id: string }>('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }),
  exportJobYaml: (id: string) => fetch(`/api/jobs/${id}/yaml`),
  subscribeJob: (id: string, onMessage: (data: unknown) => void) => {
    const es = new EventSource(`${BASE}/jobs/${id}/stream`);
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    return () => es.close();
  },

  // Collections
  getCollections: () => fetchJson<{ collections: unknown[] }>('/collections'),
  getCollection: (name: string, page: number, search?: string) => fetchJson<{ items: unknown[]; total: number; columns: string[] }>(`/collections/${name}?page=${page}&search=${encodeURIComponent(search || '')}`),
  deleteCollectionItem: (name: string, id: string) => fetchJson<void>(`/collections/${name}/items/${id}`, { method: 'DELETE' }),
  exportCollection: (name: string, format: 'jsonl' | 'csv') => fetch(`/api/collections/${name}/export?format=${format}`),

  // Actions
  runAction: (config: unknown) => fetchJson<{ id: string }>('/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }),

  // Pipelines
  getPipelines: () => fetchJson<{ pipelines: unknown[] }>('/pipelines'),
  getPipeline: (id: string) => fetchJson<{ pipeline: unknown }>(`/pipelines/${id}`),
  createPipeline: (config: unknown) => fetchJson<{ id: string }>('/pipelines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }),
  runPipeline: (id: string, trial?: boolean) => fetchJson<{ runId: string }>(`/pipelines/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trial }) }),

  // Agents
  getAgents: () => fetchJson<{ agents: unknown[] }>('/agents'),
  createAgent: (config: unknown) => fetchJson<{ id: string }>('/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }),
  runAgent: (id: string) => fetchJson<void>(`/agents/${id}/run`, { method: 'POST' }),
};
