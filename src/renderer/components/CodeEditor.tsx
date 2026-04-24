import { useState, useEffect, useCallback, useRef } from 'react'
import Editor from '@monaco-editor/react'

interface OpenFile {
  path: string
  content: string
  language: string | null
  modified: boolean
}

export default function CodeEditor({ projectPath }: { projectPath: string }): JSX.Element {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeFile = openFiles.find(f => f.path === activeFilePath) ?? null

  // Load file content when switching tabs
  useEffect(() => {
    if (!activeFilePath) return

    setOpenFiles(prev => {
      const existing = prev.find(f => f.path === activeFilePath)
      if (existing && !existing.modified) return prev // Already loaded and not modified

      window.nightshift.fs.readFile(projectPath, activeFilePath).then(content => {
        setOpenFiles(files => files.map(f =>
          f.path === activeFilePath ? { ...f, content } : f
        ))
      }).catch(err => console.error('Failed to read file:', err))

      return prev
    })
  }, [activeFilePath, projectPath])

  const handleFileSelect = useCallback(async (filePath: string): Promise<void> => {
    // Check if already open
    const exists = openFiles.some(f => f.path === filePath)
    if (!exists) {
      try {
        const content = await window.nightshift.fs.readFile(projectPath, filePath)
        const language = await window.nightshift.fs.getLanguage(filePath)
        setOpenFiles(prev => [...prev, { path: filePath, content, language, modified: false }])
      } catch (err) {
        console.error('Failed to load file:', err)
        return
      }
    }
    setActiveFilePath(filePath)
  }, [openFiles, projectPath])

  const handleSave = useCallback(async (): Promise<void> => {
    if (!activeFile || !activeFilePath) return

    try {
      await window.nightshift.fs.writeFile(projectPath, activeFilePath, activeFile.content)
      setOpenFiles(prev => prev.map(f =>
        f.path === activeFilePath ? { ...f, modified: false } : f
      ))
    } catch (err) {
      console.error('Failed to save file:', err)
    }
  }, [activeFile, activeFilePath, projectPath])

  const handleContentChange = useCallback((value: string | undefined): void => {
    if (!activeFilePath || value === undefined) return

    setOpenFiles(prev => prev.map(f =>
      f.path === activeFilePath ? { ...f, content: value, modified: true } : f
    ))

    // Auto-save on debounce (2 second delay after last change)
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      handleSave()
    }, 2000)
  }, [activeFilePath, handleSave])

  const handleCloseFile = useCallback((filePath: string): void => {
    setOpenFiles(prev => {
      const idx = prev.findIndex(f => f.path === filePath)
      const newFiles = prev.filter(f => f.path !== filePath)

      if (newFiles.length === 0) {
        setActiveFilePath(null)
      } else if (activeFilePath === filePath) {
        // Switch to adjacent tab
        const newIdx = Math.min(idx, newFiles.length - 1)
        setActiveFilePath(newFiles[newIdx].path)
      }

      return newFiles
    })
  }, [activeFilePath])

  return (
    <div className="editor-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tabs */}
      <div className="editor-tabs">
        {openFiles.map(file => (
          <div
            key={file.path}
            className={`editor-tab ${activeFilePath === file.path ? 'active' : ''}`}
            onClick={() => setActiveFilePath(file.path)}
          >
            <span>{getFileIcon(file.path)}</span>
            <span>{file.path.split('/').pop()}</span>
            {file.modified && <span style={{ color: 'var(--accent-yellow)' }}>●</span>}
            <button
              className="close-tab"
              onClick={(e) => { e.stopPropagation(); handleCloseFile(file.path) }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, marginLeft: 4 }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Editor area */}
      <div className="editor-area">
        {activeFile ? (
          <>
            <Editor
              height="calc(100vh - 120px)"
              value={activeFile.content}
              language={activeFile.language ?? 'plaintext'}
              onChange={handleContentChange}
              theme="vs-dark"
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: 'on',
              }}
            />
            <div style={{ padding: '4px 12px', fontSize: '11px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)' }}>
              {activeFile.modified ? (
                <>
                  <button className="btn btn-sm" onClick={handleSave}>Save</button>
                  {' '}Auto-save in 2s...
                </>
              ) : (
                'Saved'
              )}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
            Select a file from the sidebar to start editing
          </div>
        )}
      </div>
    </div>
  )
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const icons: Record<string, string> = {
    js: 'JS', jsx: 'RX', ts: 'TS', tsx: 'RT',
    json: '{}', jsonl: '#L', csv: ',C',
    yaml: 'Y:', yml: 'Y:',
    jinja: '{{', jinja2: '{{', tmpl: '{{',
  }
  return icons[ext] || '📄'
}
