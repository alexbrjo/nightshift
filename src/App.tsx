import { useState, useEffect } from 'react'
import FileTree from './components/FileTree'
import EditorPanel from './components/EditorPanel'
import CollectionsView from './components/CollectionsView'
import JobsView from './components/JobsView'
import PipelinesView from './components/PipelinesView'

export interface Tab {
  id: string
  name: string
  path: string
  type: 'file' | 'collection' | 'job' | 'pipeline'
}

function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [view, setView] = useState<'files' | 'collections' | 'jobs' | 'pipelines'>('files')

  useEffect(() => {
    if (tabs.length > 0 && !activeTabId) {
      setActiveTabId(tabs[0].id)
    }
  }, [tabs, activeTabId])

  const openProject = async () => {
    const path = await window.electronAPI.openDirectory()
    if (path) {
      setProjectPath(path)
      setTabs([])
      setActiveTabId(null)
    }
  }

  const openFile = (path: string, name: string) => {
    const existing = tabs.find(t => t.path === path)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    const type = getFileType(name)
    const newTab: Tab = {
      id: `tab-${Date.now()}`,
      name,
      path,
      type
    }
    setTabs([...tabs, newTab])
    setActiveTabId(newTab.id)
  }

  const closeTab = (id: string) => {
    setTabs(tabs.filter(t => t.id !== id))
    if (activeTabId === id) {
      setActiveTabId(tabs[0]?.id || null)
    }
  }

  const getFileType = (name: string): 'file' | 'collection' | 'job' | 'pipeline' => {
    if (name.endsWith('.collection.json')) return 'collection'
    if (name.endsWith('.job.json')) return 'job'
    if (name.endsWith('.pipeline.yaml')) return 'pipeline'
    return 'file'
  }

  const activeTab = tabs.find(t => t.id === activeTabId)

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <button className="btn btn-secondary" onClick={openProject}>
            Open Project
          </button>
        </div>
        
        <div style={{ display: 'flex', borderBottom: '1px solid #30363d' }}>
          {(['files', 'collections', 'jobs', 'pipelines'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                flex: 1,
                padding: '8px',
                background: view === v ? '#0d1117' : 'transparent',
                color: view === v ? '#c9d1d9' : '#8b949e',
                border: 'none',
                cursor: 'pointer',
                fontSize: '12px',
                textTransform: 'capitalize'
              }}
            >
              {v}
            </button>
          ))}
        </div>

        {view === 'files' && projectPath && (
          <FileTree
            rootPath={projectPath}
            onFileOpen={(path, name) => openFile(path, name)}
          />
        )}
        
        {(view === 'collections' || view === 'jobs' || view === 'pipelines') && projectPath && (
          <div style={{ padding: 16, fontSize: 13 }}>
            {view === 'collections' && <CollectionsView projectPath={projectPath} onItemOpen={(id) => openFile(id, `${id}.collection.json`)} />}
            {view === 'jobs' && <JobsView projectPath={projectPath} onItemOpen={(id) => openFile(id, `${id}.job.json`)} />}
            {view === 'pipelines' && <PipelinesView projectPath={projectPath} onItemOpen={(id) => openFile(id, `${id}.pipeline.yaml`)} />}
          </div>
        )}
      </div>

      <div className="main-content">
        {tabs.length > 0 ? (
          <>
            <div className="tab-bar">
              {tabs.map(tab => (
                <div
                  key={tab.id}
                  className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <span>{tab.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                    style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer' }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <EditorPanel tab={activeTab} projectPath={projectPath} />
          </>
        ) : (
          <div className="empty-state">
            {projectPath ? (
              <>
                <h2>Select a file to edit</h2>
                <p>Choose from the sidebar or create new files</p>
              </>
            ) : (
              <>
                <h2>Welcome to Nightshift</h2>
                <p>Open a directory to start your LLM experimentation project</p>
                <button className="btn btn-primary" onClick={openProject}>
                  Open Project Directory
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {projectPath && (
        <div className="status-bar">
          <span>Project: {projectPath}</span>
        </div>
      )}
    </>
  )
}

export default App
