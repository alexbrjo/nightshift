import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import type * as monacoType from 'monaco-editor'
import type { Tab } from '../App'

interface Props {
  tab: Tab | undefined
  projectPath: string | null
}

function EditorPanel({ tab, projectPath }: Props) {
  const [content, setContent] = useState<string>('')
  const [savedContent, setSavedContent] = useState<string>('')

  useEffect(() => {
    if (tab?.path) {
      loadFile(tab.path)
    }
  }, [tab])

  const loadFile = async (path: string) => {
    const data = await window.electronAPI.readFile(path)
    if (data !== null) {
      setContent(data)
      setSavedContent(data)
    }
  }

  const handleEditorMount = (_editor: any, monaco: typeof monacoType) => {
    monaco.languages.register({ id: 'jinja2' })
    
    monaco.languages.setMonarchTokensProvider('jinja2', {
      tokenizer: {
        root: [
          [/\{%[^}]*%}/, 'keyword'],
          [/\{\{[^}]*\}\}/, 'variable'],
          [/#.*$/, 'comment'],
        ]
      }
    })
  }

  const handleChange = (value: string | undefined) => {
    setContent(value || '')
  }

  const saveFile = async () => {
    if (!tab?.path) return
    await window.electronAPI.writeFile(tab.path, content)
    setSavedContent(content)
  }

  const getLanguage = (filename: string): string => {
    if (filename.endsWith('.json')) return 'json'
    if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'yaml'
    if (filename.endsWith('.js')) return 'javascript'
    if (filename.endsWith('.jinja') || filename.endsWith('.j2')) return 'jinja2'
    if (filename.endsWith('.csv')) return 'plaintext'
    return 'plaintext'
  }

  const hasChanges = content !== savedContent

  if (!tab) {
    return <div className="editor-container"><div className="empty-state">No file selected</div></div>
  }

  return (
    <div className="editor-container">
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between',
        padding: '8px 16px',
        background: '#161b22',
        borderBottom: '1px solid #30363d'
      }}>
        <span style={{ fontSize: 13, color: '#8b949e' }}>{tab.path}</span>
        {hasChanges && (
          <button className="btn btn-primary" onClick={saveFile}>
            Save
          </button>
        )}
      </div>
      <div className="editor-wrapper">
        <Editor
          height="100%"
          language={getLanguage(tab.name)}
          value={content}
          onChange={handleChange}
          theme="vs-dark"
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2
          }}
        />
      </div>
    </div>
  )
}

export default EditorPanel
