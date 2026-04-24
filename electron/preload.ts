import { contextBridge, ipcRenderer } from 'electron'

// Expose a safe API to the renderer process via context bridge
contextBridge.exposeInMainWorld('nightshift', {
  // ─── File System ──────────────────────────────────────────────────────
  fs: {
    listDirectory: (projectPath: string, relativePath: string) =>
      ipcRenderer.invoke('fs:list-directory', projectPath, relativePath),
    readFile: (projectPath: string, relativePath: string) =>
      ipcRenderer.invoke('fs:read-file', projectPath, relativePath),
    writeFile: (projectPath: string, relativePath: string, content: string) =>
      ipcRenderer.invoke('fs:write-file', projectPath, relativePath, content),
    deleteFile: (projectPath: string, relativePath: string) =>
      ipcRenderer.invoke('fs:delete-file', projectPath, relativePath),
    getLanguage: (filename: string) =>
      ipcRenderer.invoke('fs:get-language', filename),
    findFiles: (projectPath: string, extensions: string[]) =>
      ipcRenderer.invoke('fs:find-files', projectPath, extensions),
  },

  // ─── Project ──────────────────────────────────────────────────────────
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    getCollections: (projectPath: string) =>
      ipcRenderer.invoke('project:get-collections', projectPath),
  },

  // ─── Inference Jobs ──────────────────────────────────────────────────
  job: {
    create: (projectPath: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke('job:create', projectPath, config),
    getResults: (projectPath: string, jobId: string) =>
      ipcRenderer.invoke('job:get-results', projectPath, jobId),
    getStatus: (projectPath: string, jobId: string) =>
      ipcRenderer.invoke('job:get-status', projectPath, jobId),
    updateStatus: (projectPath: string, jobId: string, status: string) =>
      ipcRenderer.invoke('job:update-status', projectPath, jobId, status),
    exportYaml: (projectPath: string, jobId: string) =>
      ipcRenderer.invoke('job:export-yaml', projectPath, jobId),
  },

  // ─── Collections ─────────────────────────────────────────────────────
  collection: {
    getItems: (projectPath: string, name: string, page?: number, pageSize?: number) =>
      ipcRenderer.invoke('collection:get-items', projectPath, name, page ?? 1, pageSize ?? 50),
    search: (projectPath: string, name: string, query: string, page?: number, pageSize?: number) =>
      ipcRenderer.invoke('collection:search', projectPath, name, query, page ?? 1, pageSize ?? 50),
    deleteItem: (projectPath: string, name: string, itemId: string) =>
      ipcRenderer.invoke('collection:delete-item', projectPath, name, itemId),
    exportJsonl: (projectPath: string, name: string) =>
      ipcRenderer.invoke('collection:export-jsonl', projectPath, name),
    exportCsv: (projectPath: string, name: string) =>
      ipcRenderer.invoke('collection:export-csv', projectPath, name),
  },

  // ─── Bulk Actions ────────────────────────────────────────────────────
  action: {
    create: (projectPath: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke('action:create', projectPath, config),
    execute: (projectPath: string, actionId: string) =>
      ipcRenderer.invoke('action:execute', projectPath, actionId),
  },

  // ─── Pipelines ───────────────────────────────────────────────────────
  pipeline: {
    create: (projectPath: string, name: string) =>
      ipcRenderer.invoke('pipeline:create', projectPath, name),
    addStage: (projectPath: string, pipelineId: string, stageConfig: Record<string, unknown>) =>
      ipcRenderer.invoke('pipeline:add-stage', projectPath, pipelineId, stageConfig),
    getStages: (projectPath: string, pipelineId: string) =>
      ipcRenderer.invoke('pipeline:get-stages', projectPath, pipelineId),
    run: (projectPath: string, pipelineId: string, groupId?: string) =>
      ipcRenderer.invoke('pipeline:run', projectPath, pipelineId, groupId),
    trialRun: (projectPath: string, pipelineId: string) =>
      ipcRenderer.invoke('pipeline:trial-run', projectPath, pipelineId),
    exportYaml: (projectPath: string, pipelineId: string) =>
      ipcRenderer.invoke('pipeline:export-yaml', projectPath, pipelineId),
  },

  // ─── Analysis Agents ─────────────────────────────────────────────────
  agent: {
    createConfig: (projectPath: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke('agent:create-config', projectPath, config),
    exportYaml: (_projectPath: string, agentId: string) =>
      ipcRenderer.invoke('agent:export-yaml', _projectPath, agentId),
  },

  // ─── YAML Utilities ──────────────────────────────────────────────────
  yaml: {
    import: (content: string) => ipcRenderer.invoke('yaml:import', content),
    export: (data: Record<string, unknown>) => ipcRenderer.invoke('yaml:export', data),
  },

  // ─── Event Listeners ────────────────────────────────────────────────
  onJobProgress: (callback: (event: { jobId: string; sampleIndex: number; status: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as { jobId: string; sampleIndex: number; status: string })
    ipcRenderer.on('job-progress', handler)
    return () => ipcRenderer.removeListener('job-progress', handler)
  },
})
