import { create } from 'zustand';
import type { Project, FileNode, JobConfig, JobResult, Collection, Pipeline, AnalysisAgent } from '@/types';

export interface OpenFile {
  path: string;
  content: string;
  unsaved: boolean;
  history: string[];
  historyIndex: number;
}

interface AppState {
  // Projects
  projects: Project[];
  activeProject: Project | null;
  openProjects: Project[];

  // File system
  fileTree: FileNode[];
  openFiles: OpenFile[];
  activeFilePath: string | null;

  // Jobs
  jobs: JobConfig[];
  jobResults: Record<string, JobResult[]>;

  // Collections
  collections: Collection[];

  // Pipelines
  pipelines: Pipeline[];
  activePipeline: Pipeline | null;

  // Analysis Agents
  agents: AnalysisAgent[];
  activeAgent: AnalysisAgent | null;

  // UI State
  sidebarOpen: boolean;
  activeView: 'explorer' | 'inference' | 'javascript' | 'collections' | 'pipelines' | 'agents';
}

interface StoreActions {
  // Projects
  openProject: (project: Project) => void;
  closeProject: (projectId: string) => void;
  setActiveProject: (project: Project | null) => void;

  // File system
  setFileTree: (tree: FileNode[]) => void;
  openFile: (path: string, content: string) => void;
  closeFile: (path: string) => void;
  setActiveFile: (path: string | null) => void;
  updateFileContent: (path: string, content: string, pushHistory?: boolean) => void;
  undoFile: (path: string) => void;
  redoFile: (path: string) => void;

  // Jobs
  addJob: (job: JobConfig) => void;
  updateJob: (id: string, updates: Partial<JobConfig>) => void;
  removeJob: (id: string) => void;
  setJobResults: (jobId: string, results: JobResult[]) => void;
  addJobResult: (jobId: string, result: JobResult) => void;

  // Collections
  addCollection: (collection: Collection) => void;
  updateCollection: (id: string, updates: Partial<Collection>) => void;

  // Pipelines
  addPipeline: (pipeline: Pipeline) => void;
  updatePipeline: (id: string, updates: Partial<Pipeline>) => void;
  setActivePipeline: (pipeline: Pipeline | null) => void;

  // Agents
  addAgent: (agent: AnalysisAgent) => void;
  updateAgent: (id: string, updates: Partial<AnalysisAgent>) => void;
  setActiveAgent: (agent: AnalysisAgent | null) => void;

  // UI
  toggleSidebar: () => void;
  setActiveView: (view: AppState['activeView']) => void;
}

const initialState: AppState = {
  projects: [],
  activeProject: null,
  openProjects: [],
  fileTree: [],
  openFiles: [],
  activeFilePath: null,
  jobs: [],
  jobResults: {},
  collections: [],
  pipelines: [],
  activePipeline: null,
  agents: [],
  activeAgent: null,
  sidebarOpen: true,
  activeView: 'explorer',
};

export const useStore = create<AppState & StoreActions>()((set) => ({
  ...initialState,

  openProject: (project) => set((state) => {
    const exists = state.openProjects.find(p => p.id === project.id);
    return {
      projects: exists ? state.projects : [...state.projects, project],
      openProjects: exists ? state.openProjects : [...state.openProjects, project],
      activeProject: project,
    };
  }),

  closeProject: (projectId) => set((state) => ({
    openProjects: state.openProjects.filter(p => p.id !== projectId),
    activeProject: state.activeProject?.id === projectId ? null : state.activeProject,
  })),

  setActiveProject: (project) => set({ activeProject: project }),

  setFileTree: (tree) => set({ fileTree: tree }),

  openFile: (path, content) => set((state) => {
    const existing = state.openFiles.find(f => f.path === path);
    if (existing) return { activeFilePath: path };
    return {
      openFiles: [...state.openFiles, {
        path,
        content,
        unsaved: false,
        history: [content],
        historyIndex: 0,
      }],
      activeFilePath: path,
    };
  }),

  closeFile: (path) => set((state) => ({
    openFiles: state.openFiles.filter(f => f.path !== path),
    activeFilePath: state.activeFilePath === path
      ? state.openFiles[0]?.path ?? null
      : state.activeFilePath,
  })),

  setActiveFile: (path) => set({ activeFilePath: path }),

  updateFileContent: (path, content, pushHistory = true) => set((state) => ({
    openFiles: state.openFiles.map(f => {
      if (f.path !== path) return f;
      const newHistory = pushHistory ? [...f.history.slice(0, f.historyIndex + 1), content] : f.history;
      return {
        ...f,
        content,
        unsaved: true,
        history: newHistory,
        historyIndex: pushHistory ? newHistory.length - 1 : f.historyIndex,
      };
    }),
  })),

  undoFile: (path) => set((state) => ({
    openFiles: state.openFiles.map(f => {
      if (f.path !== path || f.historyIndex <= 0) return f;
      const newIndex = f.historyIndex - 1;
      return { ...f, content: f.history[newIndex], historyIndex: newIndex };
    }),
  })),

  redoFile: (path) => set((state) => ({
    openFiles: state.openFiles.map(f => {
      if (f.path !== path || f.historyIndex >= f.history.length - 1) return f;
      const newIndex = f.historyIndex + 1;
      return { ...f, content: f.history[newIndex], historyIndex: newIndex };
    }),
  })),

  addJob: (job) => set((state) => ({ jobs: [...state.jobs, job] })),
  updateJob: (id, updates) => set((state) => ({
    jobs: state.jobs.map(j => j.id === id ? { ...j, ...updates } : j),
  })),
  removeJob: (id) => set((state) => ({
    jobs: state.jobs.filter(j => j.id !== id),
    jobResults: Object.fromEntries(
      Object.entries(state.jobResults).filter(([k]) => k !== id)
    ),
  })),
  setJobResults: (jobId, results) => set((state) => ({
    jobResults: { ...state.jobResults, [jobId]: results },
  })),
  addJobResult: (jobId, result) => set((state) => ({
    jobResults: {
      ...state.jobResults,
      [jobId]: [...(state.jobResults[jobId] || []), result],
    },
  })),

  addCollection: (collection) => set((state) => ({
    collections: [...state.collections, collection],
  })),
  updateCollection: (id, updates) => set((state) => ({
    collections: state.collections.map(c => c.id === id ? { ...c, ...updates } : c),
  })),

  addPipeline: (pipeline) => set((state) => ({
    pipelines: [...state.pipelines, pipeline],
  })),
  updatePipeline: (id, updates) => set((state) => ({
    pipelines: state.pipelines.map(p => p.id === id ? { ...p, ...updates } : p),
  })),
  setActivePipeline: (pipeline) => set({ activePipeline: pipeline }),

  addAgent: (agent) => set((state) => ({
    agents: [...state.agents, agent],
  })),
  updateAgent: (id, updates) => set((state) => ({
    agents: state.agents.map(a => a.id === id ? { ...a, ...updates } : a),
  })),
  setActiveAgent: (agent) => set({ activeAgent: agent }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setActiveView: (view) => set({ activeView: view }),
}));
