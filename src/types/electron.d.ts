import { FileEntry } from './index'

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

export interface ElectronAPI {
  openDirectory: () => Promise<string | null>
  readDir: (path: string) => Promise<FileEntry[]>
  readFile: (path: string) => Promise<string | null>
  writeFile: (path: string, content: string) => Promise<boolean>
  exists: (path: string) => Promise<boolean>
  getUserDataPath: () => Promise<string>
  dbInsertCollection: (data: CollectionRow) => Promise<boolean>
  dbGetCollections: () => Promise<CollectionRow[]>
  dbInsertCollectionItem: (data: CollectionItemRow) => Promise<boolean>
  dbGetCollectionItems: (collectionId: string) => Promise<CollectionItemRow[]>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
