import { contextBridge, ipcRenderer } from 'electron'

export interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

export interface CollectionRow {
  id: string
  name: string
  created_at: number
  schema_json?: string
}

export interface CollectionItemRow {
  id: string
  collection_id: string
  rendered_prompt?: string
  raw_response?: string
  parsed_content?: string
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  latency_ms?: number
  status: string
  error?: string
}

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readDir: (path: string) => ipcRenderer.invoke('fs:readDir', path),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
  exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),
  dbInsertCollection: (data: CollectionRow) => ipcRenderer.invoke('db:insertCollection', data),
  dbGetCollections: () => ipcRenderer.invoke('db:getCollections'),
  dbInsertCollectionItem: (data: CollectionItemRow) => ipcRenderer.invoke('db:insertCollectionItem', data),
  dbGetCollectionItems: (collectionId: string) => ipcRenderer.invoke('db:getCollectionItems', collectionId)
})
