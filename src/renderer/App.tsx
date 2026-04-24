import { createRoot } from 'react-dom/client'
import { useState, useCallback } from 'react'
import './styles.css'
import FileTree from '@renderer/components/FileTree'
import CodeEditor from '@renderer/components/CodeEditor'
import BulkInference from '@renderer/pages/BulkInference'
import CollectionsManager from '@renderer/pages/CollectionsManager'
import Pipelines from '@renderer/pages/Pipelines'

type ActiveView = 'editor' | 'inference' | 'collections' | 'pipelines'

declare global {
  interface Window {
    nightshift: {
      fs: {
        listDirectory: (projectPath: string, relativePath: string) => Promise<Array<{ name: string; path: string; isDirectory: boolean; size?: number }>>
        readFile: (projectPath: string, relativePath: string) => Promise<string>
        writeFile: (projectPath: string, relativePath: string, content: string) => Promise<boolean>
        deleteFile: (projectPath: string, relativePath: string) => Promise<boolean>
        getLanguage: (filename: string) => Promise<string | null>
        findFiles: (projectPath: string, extensions: string[]) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
      }
      project: {
        open: () => Promise<{ id: string; path: string; name: string } | null>
        getCollections: (projectPath: string) => Promise<string[]>
      }
      job: {
        create: (projectPath: string, config: Record<string, unknown>) => Promise<string>
        getResults: (projectPath: string, jobId: string) => Promise<unknown[]>
        getStatus: (projectPath: string, jobId: string) => Promise<{ id: string; name: string; status: string; total_samples: number; completed_samples: number; errored_samples: number }>
        updateStatus: (projectPath: string, jobId: string, status: string) => Promise<void>
        exportYaml: (projectPath: string, jobId: string) => Promise<string>
      }
      collection: {
        getItems: (projectPath: string, name: string, page?: number, pageSize?: number) => Promise<{ items: unknown[]; total: number }>
        search: (projectPath: string, name: string, query: string, page?: number, pageSize?: number) => Promise<{ items: unknown[]; total: number }>
        deleteItem: (projectPath: string, name: string, itemId: string) => Promise<void>
        exportJsonl: (projectPath: string, name: string) => Promise<string>
        exportCsv: (projectPath: string, name: string) => Promise<string>
      }
      action: {
        create: (projectPath: string, config: Record<string, unknown>) => Promise<string>
        execute: (projectPath: string, actionId: string) => Promise<unknown>
      }
      pipeline: {
        create: (projectPath: string, name: string) => Promise<string>
        addStage: (projectPath: string, pipelineId: string, stageConfig: Record<string, unknown>) => Promise<void>
        getStages: (projectPath: string, pipelineId: string) => Promise<unknown[]>
        run: (projectPath: string, pipelineId: string, groupId?: string) => Promise<string>
        trialRun: (projectPath: string, pipelineId: string) => Promise<string>
        exportYaml: (projectPath: string, pipelineId: string) => Promise<string>
      }
      agent: {
        createConfig: (projectPath: string, config: Record<string, unknown>) => Promise<string>
        exportYaml: (projectPath: string, agentId: string) => Promise<string>
      }
      yaml: {
        import: (content: string) => Promise<unknown>
        export: (data: Record<string, unknown>) => Promise<string>
      }
      onJobProgress: (callback: (event: { jobId: string; sampleIndex: number; status: string }) => void) => () => void
    }
  }
}

function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; path: string; name: string } | null>(null)
  const [activeView, setActiveView] = useState<ActiveView>('editor')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const handleOpenProject = useCallback(async () => {
    const result = await window.nightshift.project.open()
    if (result) {
      setProject(result)
    }
  }, [])

  return (
    <div className="app-container">
      {/* Top bar */}
      <header className="top-bar">
        <button
          className="icon-btn"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          title="Toggle sidebar"
        >
          ☰
        </button>
        <span className="app-title">Nightshift</span>
        {project && <span className="project-name">{project.name}</span>}
        <div className="top-bar-actions">
          {!project && (
            <button className="btn btn-primary" onClick={handleOpenProject}>
              Open Project
            </button>
          )}
        </div>
      </header>

      <div className="app-body">
        {/* Sidebar */}
        {sidebarOpen && project && (
          <aside className="sidebar">
            <nav className="sidebar-nav">
              <NavButton active={activeView === 'editor'} onClick={() => setActiveView('editor')} icon="📄" label="Editor" />
              <NavButton active={activeView === 'inference'} onClick={() => setActiveView('inference')} icon="⚡" label="Bulk Inference" />
              <NavButton active={activeView === 'collections'} onClick={() => setActiveView('collections')} icon="📦" label="Collections" />
              <NavButton active={activeView === 'pipelines'} onClick={() => setActiveView('pipelines')} icon="🔗" label="Pipelines" />
            </nav>

            {activeView === 'editor' && (
              <FileTree projectPath={project.path} onFileSelect={() => setActiveView('editor')} />
            )}
          </aside>
        )}

        {/* Main content */}
        <main className="main-content">
          {!project ? (
            <div className="empty-state">
              <h1>Welcome to Nightshift</h1>
              <p>An experimentation platform for evaluating LLM-generated context.</p>
              <button className="btn btn-primary" onClick={handleOpenProject}>
                Open a Project Folder
              </button>
            </div>
          ) : (
            <>
              {activeView === 'editor' && <CodeEditor projectPath={project.path} />}
              {activeView === 'inference' && <BulkInference projectPath={project.path} />}
              {activeView === 'collections' && <CollectionsManager projectPath={project.path} />}
              {activeView === 'pipelines' && <Pipelines projectPath={project.path} />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }): JSX.Element {
  return (
    <button className={`nav-btn ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </button>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
