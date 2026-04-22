import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export interface FileContent {
  content: string
  path: string
  language: string
}

export interface DirectoryEntry {
  name: string
  path: string
  is_directory: boolean
}

export interface CollectionItem {
  id: number
  data_json: string
  created_at: string
}

interface ProjectState {
  isOpen: boolean
  path: string | null
  name: string | null
  files: DirectoryEntry[]
  currentFile: FileContent | null
  collections: any[]
  jobs: any[]
  
  openProject: (path: string) => Promise<void>
  readFile: (path: string) => Promise<void>
  writeFile: (path: string, content: string) => Promise<boolean>
  deleteFile: (path: string) => Promise<boolean>
  listDirectory: (path?: string) => Promise<void>
  closeProject: () => void
  
  setCollections: (collections: any[]) => void
  addJob: (job: any) => void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  isOpen: false,
  path: null,
  name: null,
  files: [],
  currentFile: null,
  collections: [],
  jobs: [],
  
  openProject: async (path: string) => {
    try {
      await invoke('open_project', { params: { path } })
      set({ isOpen: true, path, name: path.split('/').pop() || 'Untitled' })
      get().listDirectory()
    } catch (error) {
      console.error('Failed to open project:', error)
      throw error
    }
  },
  
  readFile: async (path: string) => {
    try {
      const content = await invoke<FileContent>('read_file', { params: { path } })
      set({ currentFile: content })
    } catch (error) {
      console.error('Failed to read file:', error)
      throw error
    }
  },
  
  writeFile: async (path: string, content: string) => {
    try {
      return await invoke<boolean>('write_file', { params: { path, content } })
    } catch (error) {
      console.error('Failed to write file:', error)
      throw error
    }
  },
  
  deleteFile: async (path: string) => {
    try {
      return await invoke<boolean>('delete_file', { params: { path } })
    } catch (error) {
      console.error('Failed to delete file:', error)
      throw error
    }
  },
  
  listDirectory: async (path?: string) => {
    try {
      const entries = await invoke<DirectoryEntry[]>('list_directory', { path })
      set({ files: entries })
    } catch (error) {
      console.error('Failed to list directory:', error)
      throw error
    }
  },
  
  closeProject: () => {
    set({ 
      isOpen: false, 
      path: null, 
      name: null,
      files: [],
      currentFile: null 
    })
  },
  
  setCollections: (collections) => set({ collections }),
  addJob: (job) => set((state) => ({ jobs: [...state.jobs, job] })),
}))
