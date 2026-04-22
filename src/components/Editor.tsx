import { useRef, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { useProjectStore } from '../store/project'

export default function CodeEditor() {
  const { currentFile } = useProjectStore()
  const editorRef = useRef<any>(null)
  const lastSavedContent = useRef<string>('')
  
  useEffect(() => {
    lastSavedContent.current = currentFile?.content || ''
  }, [currentFile])
  
  const handleEditorChange = (_value: string | undefined) => {
    // Auto-save with debounce would go here
    if (editorRef.current) {
      // Could implement auto-save logic
    }
  }
  
  const getLanguage = () => {
    if (!currentFile?.language) return 'plaintext'
    
    switch (currentFile.language) {
      case 'jinja':
        return 'html'
      case 'json':
        return 'json'
      case 'javascript':
        return 'javascript'
      case 'csv':
        return 'plaintext'
      case 'yaml':
        return 'yaml'
      default:
        return 'plaintext'
    }
  }
  
  if (!currentFile) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <div className="text-center">
          <p>Select a file to edit</p>
        </div>
      </div>
    )
  }
  
  return (
    <div className="flex-1 bg-gray-900">
      <Editor
        height="100%"
        language={getLanguage()}
        value={currentFile.content}
        onChange={handleEditorChange}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          wordWrap: 'on',
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          formatOnPaste: true,
          formatOnType: true,
        }}
      />
    </div>
  )
}
