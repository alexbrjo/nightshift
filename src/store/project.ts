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
  pipelines: any[]
  
  openProject: (path: string) => Promise<void>
  readFile: (path: string) => Promise<void>
  writeFile: (path: string, content: string) => Promise<boolean>
  deleteFile: (path: string) => Promise<boolean>
  listDirectory: (path?: string) => Promise<void>
  closeProject: () => void
  
  setCollections: (collections: any[]) => void
  addJob: (job: any) => void
  savePipeline: (name: string, definitionYaml: string) => Promise<number>
  deleteCollectionItem: (collectionId: number, itemId: number) => Promise<boolean>
  runAnalysisAgent: (experimentRunId: string) => Promise<any>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  isOpen: false,
  path: null,
  name: null,
  files: [],
  currentFile: null,
  collections: [],
  jobs: [],
  pipelines: [],
  
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
  
  savePipeline: async (name: string, definitionYaml: string) => {
    try {
      const result = await invoke<number>('save_pipeline', { 
        params: { name, definition_yaml: definitionYaml } 
      })
      set((state) => ({ 
        pipelines: [...state.pipelines, { id: result, name, definition: definitionYaml }] 
      }))
      return result
    } catch (error) {
      console.error('Failed to save pipeline:', error)
      throw error
    }
  },
  
  deleteCollectionItem: async (collectionId: number, itemId: number) => {
    try {
      return await invoke<boolean>('delete_collection_item', { 
        params: { collection_id: collectionId, item_id: itemId } 
      })
    } catch (error) {
      console.error('Failed to delete collection item:', error)
      throw error
    }
  },
  
  runAnalysisAgent: async (experimentRunId: string) => {
    try {
      return await invoke('run_analysis_agent', { 
        params: { 
          config: { 
            experiment_run_id: parseInt(experimentRunId),
            query_template_path: null,
            supplement_sources: [],
            summary_prompt_path: null
          } 
        } 
      })
    } catch (error) {
      console.error('Failed to run analysis agent:', error)
      throw error
    }
  },
}))
