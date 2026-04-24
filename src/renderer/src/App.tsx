import React, { useState, useEffect } from 'react'
import { FileInfo } from '../../common/types'
import InferenceJobForm from './components/InferenceJobForm'
import BulkActionForm from './components/BulkActionForm'
import AgentForm from './components/AgentForm'
import { InferenceJobConfig, InferenceJob, Pipeline, AgentConfig } from '../../common/models'

type View = 'files' | 'inference-jobs' | 'collections' | 'pipelines' | 'agents' | 'bulk-actions'

interface CollectionItem {
  id: string;
  data: any;
  createdAt: number;
}

function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [files, setFiles] = useState<FileInfo[]>([])
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)
  const [currentView, setCurrentView] = useState<View>('files')
  const [jobs, setJobs] = useState<InferenceJob[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [collectionItems, setCollectionItems] = useState<CollectionItem[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [agents, setAgents] = useState<AgentConfig[]>([])

  useEffect(() => {
    if (currentView === 'inference-jobs') {
      loadJobs()
    }
    if (currentView === 'pipelines') {
      loadPipelines()
    }
    if (currentView === 'agents') {
      loadAgents()
    }
  }, [currentView])

  const loadJobs = async () => {
    const fetchedJobs = await window.electron.ipcRenderer.invoke('jobs:get')
    setJobs(fetchedJobs)
  }

  const loadPipelines = async () => {
    const fetchedPipelines = await window.electron.ipcRenderer.invoke('pipelines:get')
    setPipelines(fetchedPipelines)
  }

  const loadAgents = async () => {
    const fetchedAgents = await window.electron.ipcRenderer.invoke('agents:get')
    setAgents(fetchedAgents)
  }

  const loadCollectionItems = async (jobId: string) => {
    const items = await window.electron.ipcRenderer.invoke('collections:getItems', jobId)
    setCollectionItems(items)
  }

  const openDirectory = async () => {
    const path = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (path) {
      setProjectPath(path)
      const contents = await window.electron.ipcRenderer.invoke('fs:readDirectory', path)
      setFiles(contents)
    }
  }

  const selectFile = async (file: FileInfo) => {
    if (file.isDirectory) return
    const content = await window.electron.ipcRenderer.invoke('fs:readFile', file.path)
    setSelectedFile(file)
    setFileContent(content)
  }

  const saveFile = async () => {
    if (!selectedFile) return
    setIsSaving(true)
    try {
      await window.electron.ipcRenderer.invoke('fs:writeFile', selectedFile.path, fileContent)
      alert('File saved successfully!')
    } catch (err) {
      console.error(err)
      alert('Failed to save file.')
    } finally {
      setIsSaving(false)
    }
  }

  const deleteFile = async (file: FileInfo) => {
    if (!confirm(`Are you sure you want to delete ${file.name}?`)) return
    try {
      await window.electron.ipcRenderer.invoke('fs:deleteFile', file.path)
      setFiles(files.filter(f => f.path !== file.path))
      if (selectedFile?.path === file.path) {
        setSelectedFile(null)
        setFileContent('')
      }
    } catch (err) {
      console.error(err)
      alert('Failed to delete file.')
    }
  }

  const handleCreateInferenceJob = async (config: InferenceJobConfig) => {
    try {
      const newJob = await window.electron.ipcRenderer.invoke('jobs:create', config)
      setJobs([...jobs, newJob])
      alert(`Inference job "${config.name}" created! (Check console for details)`)
    } catch (err) {
      console.error(err)
      alert('Failed to create job.')
    }
  }

  const handleCreateBulkAction = async (config: any) => {
    try {
      await window.electron.ipcRenderer.invoke('bulk-actions:run', config)
      alert('Bulk action started!')
    } catch (err) {
      console.error(err)
      alert('Failed to start bulk action.')
    }
  }

  const handleCreateAgent = async (config: AgentConfig) => {
    try {
      const newAgent = await window.electron.ipcRenderer.invoke('agents:create', config)
      setAgents([...agents, newAgent])
      alert(`Agent "${config.name}" created!`)
    } catch (err) {
      console.error(err)
      alert('Failed to create agent.')
    }
  }

  const deleteCollectionItem = async (itemId: string) => {
    if (!confirm('Are you sure you want to delete this item?')) return
    try {
      await window.electron.ipcRenderer.invoke('collections:deleteItem', itemId)
      setCollectionItems(collectionItems.filter(item => item.id !== itemId))
    } catch (err) {
      console.error(err)
      alert('Failed to delete item.')
    }
  }

  const getLanguage = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase()
    switch (ext) {
      case 'js': return 'javascript'
      case 'json': return 'json'
      case 'jsonl': return 'json' 
      case 'csv': return 'csv'
      case 'yaml':
      case 'yml': return 'yaml'
      case 'jinja2':
      case 'j2': return 'html' 
      default: return 'plaintext'
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      {/* Sidebar */}
      <div style={{ width: '250px', borderRight: '1px solid #ccc', padding: '10px', overflowY: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Nightshift</h3>
        <button onClick={openDirectory} style={{ width: '100%', marginBottom: '10px' }}>
          Open Project...
        </button>

        {projectPath && currentView === 'files' && (
          <div>
            <div style={{ fontSize: '0.8em', color: '#666', marginBottom: '10px', wordBreak: 'break-all' }}>
              {projectPath}
            </div>
            <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
              {files.map((file) => (
                <li key={file.path} style={{ cursor: 'pointer', padding: '2px 5px' }}>
                  {file.isDirectory ? '📁' : '📄'} {file.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        <nav style={{ marginTop: '20px' }}>
          <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
            <li onClick={() => setCurrentView('files')} style={{ cursor: 'pointer', fontWeight: currentView === 'files' ? 'bold' : 'normal' }}>Files</li>
            <li onClick={() => setCurrentView('inference-jobs')} style={{ cursor: 'pointer', fontWeight: currentView === 'inference-jobs' ? 'bold' : 'normal' }}>Inference Jobs</li>
            <li onClick={() => setCurrentView('collections')} style={{ cursor: 'pointer', fontWeight: currentView === 'collections' ? 'bold' : 'normal' }}>Collections</li>
            <li onClick={() => setCurrentView('pipelines')} style={{ cursor: 'pointer', fontWeight: currentView === 'pipelines' ? 'bold' : 'normal' }}>Pipelines</li>
            <li onClick={() => setCurrentView('agents')} style={{ cursor: 'pointer', fontWeight: currentView === 'agents' ? 'bold' : 'normal' }}>Agents</li>
            <li onClick={() => setCurrentView('bulk-actions')} style={{ cursor: 'pointer', fontWeight: currentView === 'bulk-actions' ? 'bold' : 'normal' }}>Bulk Actions</li>
          </ul>
        </nav>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {!projectPath ? (
          <div style={{ padding: '20px' }}>
            <h1>Welcome to Nightshift</h1>
            <p>Select a project folder to get started.</p>
          </div>
        ) : (
          <>
            {currentView === 'files' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {selectedFile ? (
                  <>
                    <div style={{ padding: '10px', borderBottom: '1px solid #ccc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{selectedFile.name} ({getLanguage(selectedFile.name)})</span>
                      <button onClick={saveFile} disabled={isSaving}>
                        {isSaving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Editor
                        height="100%"
                        defaultLanguage={getLanguage(selectedFile.name)}
                        value={fileContent}
                        onChange={(value) => setFileContent(value || '')}
                        theme="vs-dark"
                      />
                    </div>
                  </>
                ) : (
                  <div style={{ padding: '20px' }}>
                    <h1>Project Files</h1>
                    <p>Select a file from the sidebar to edit it.</p>
                  </div>
                )}
              </div>
            )}

            {currentView === 'inference-jobs' && (
              <div style={{ padding: '20px', overflowY: 'auto' }}>
                <h1>Inference Jobs</h1>
                <div style={{ marginBottom: '20px' }}>
                  <h3>Existing Jobs</h3>
                  <ul style={{ listStyleType: 'none', padding: 0 }}>
                    {jobs.map(job => (
                      <li 
                        key={job.id} 
                        onClick={() => setSelectedJobId(job.id)}
                        style={{ cursor: 'pointer', padding: '5px', borderBottom: '1px solid #eee', backgroundColor: selectedJobId === job.id ? '#f0f0f0' : 'transparent' }}
                      >
                        {job.config.name} - {job.status} ({new Date(job.createdAt).toLocaleString()})
                      </li>
                    ))}
                  </ul>
                </div>
                <hr />
                <h3 style={{ marginTop: '20px' }}>Create New Job</h3>
                <InferenceJobForm onSave={handleCreateInferenceJob} />
              </div>
            )}

            {currentView === 'collections' && (
              <div style={{ padding: '20px', overflowY: 'auto' }}>
                <h1>Collections</h1>
                {!selectedJobId ? (
                  <div>
                    <h3>Select a job to view its collection</h3>
                    <ul style={{ listStyleType: 'none', padding: 0 }}>
                      {jobs.map(job => (
                        <li key={job.id} onClick={() => setSelectedJobId(job.id)} style={{ cursor: 'pointer', padding: '5px', borderBottom: '1px solid #eee' }}>
                          Collection for {job.config.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div>
                    <button onClick={() => setSelectedJobId(null)}>Back to Jobs</button>
                    <h3 style={{ marginTop: '10px' }}>Items in Collection</h3>
                    {collectionItems.length === 0 ? <p>No items found.</p> : (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ textAlign: 'left', backgroundColor: '#f5f5f5' }}>
                          <tr>
                            <th style={{ padding: '8px', borderBottom: '2px solid #ccc' }}>ID</th>
                            <th style={{ padding: '8px', borderBottom: '2px solid #ccc' }}>Data</th>
                            <th style={{ padding: '8px', borderBottom: '2px solid #ccc' }}>Created At</th>
                            <th style={{ padding: '8px', borderBottom: '2px solid #ccc' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {collectionItems.map(item => (
                            <tr key={item.id} style={{ borderBottom: '1px solid #eee' }}>
                              <td style={{ padding: '8px' }}>{item.id}</td>
                              <td style={{ padding: '8px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {JSON.stringify(item.data)}
                              </td>
                              <td style={{ padding: '8px' }}>{new Date(item.createdAt).toLocaleString()}</td>
                              <td style={{ padding: '8px' }}>
                                <button onClick={() => deleteCollectionItem(item.id)}>Delete</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )}

            {currentView === 'pipelines' && (
              <div style={{ padding: '20px' }}>
                <h1>Pipelines</h1>
                {!pipelines.length ? (
                  <div>
                    <h3>No pipelines found.</h3>
                    <button onClick={() => {}} style={{ marginBottom: '20px' }}>Create New Pipeline</button>
                  </div>
                ) : (
                  <ul style={{ listStyleType: 'none', padding: 0 }}>
                    {pipelines.map(p => <li key={p.id}>{p.config.name}</li>)}
                  </ul>
                )}
              </div>
            )}

            {currentView === 'agents' && (
              <div style={{ padding: '20px', overflowY: 'auto' }}>
                <h1>Agents</h1>
                {!agents.length ? (
                  <div>
                    <h3>No agents found.</h3>
                    <AgentForm onSave={handleCreateAgent} />
                  </div>
                ) : (
                  <div>
                    <h3>Existing Agents</h3>
                    <ul style={{ listStyleType: 'none', padding: 0 }}>
                      {agents.map(agent => (
                        <li key={agent.name} style={{ padding: '5px', borderBottom: '1px solid #eee' }}>
                          {agent.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {currentView === 'bulk-actions' && (
              <div style={{ padding: '20px', overflowY: 'auto' }}>
                <h1>Bulk Actions</h1>
                <div style={{ marginBottom: '20px' }}>
                  <h3>Run New Bulk Action</h3>
                  <BulkActionForm onSave={handleCreateBulkAction} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default App






