import { useEffect, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { useStore } from '../lib/store';
import { X, Save, Undo2, Redo2 } from 'lucide-react';

function getFileType(path: string): 'javascript' | 'json' | 'yaml' | 'plaintext' | 'text' {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      if (path.includes('.jinja') || path.includes('.j2')) return 'plaintext'; // Jinja2 uses plaintext for now
      return 'text';
  }
}

export default function CodeEditor() {
  const { openFiles, activeFilePath, closeFile, setActiveFile, updateFileContent, undoFile, redoFile } = useStore();
  const editorRef = useRef<any>(null);

  const activeFile = openFiles.find(f => f.path === activeFilePath);

  useEffect(() => {
    if (activeFile && editorRef.current) {
      // Editor content is managed by Monaco's model
    }
  }, [activeFilePath]);

  function handleSave() {
    if (!activeFile || !activeFilePath) return;
    
    const editor = editorRef.current;
    if (editor) {
      const content = editor.getValue();
      // In production, invoke Tauri command to write file
      console.log('Saving:', activeFilePath);
      updateFileContent(activeFilePath, content, false);
    }
  }

  function handleEditorChange(value: string | undefined) {
    if (activeFilePath && value !== undefined) {
      updateFileContent(activeFilePath, value);
    }
  }

  function handleEditorDidMount(editor: any) {
    editorRef.current = editor;
    
    // Register keyboard shortcuts
    editor.addCommand(2048 /* Ctrl+S / Cmd+S */, () => {
      handleSave();
    });
  }

  if (!activeFile) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary">
        <div className="text-center">
          <p className="text-lg text-text-muted mb-2">No file open</p>
          <p className="text-sm text-text-muted">Select a file from the explorer to edit</p>
        </div>
      </div>
    );
  }

  const ext = activeFile.path.split('.').pop()?.toLowerCase();
  const isJinja = ext === 'j2' || activeFile.path.includes('.jinja');

  return (
    <div className="flex-1 flex flex-col bg-bg-primary">
      {/* Tab bar */}
      {openFiles.length > 1 && (
        <div className="flex border-b border-border bg-bg-secondary overflow-x-auto">
          {openFiles.map(file => (
            <button
              key={file.path}
              onClick={() => setActiveFile(file.path)}
              className={`flex items-center gap-2 px-3 py-2 text-sm border-r border-border transition-colors min-w-fit ${
                file.path === activeFilePath
                  ? 'bg-bg-primary text-text-primary border-b-2 border-b-accent'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span className="truncate max-w-[150px]">{file.path.split('/').pop()}</span>
              {file.unsaved && <span className="w-2 h-2 rounded-full bg-accent" />}
              <X
                className="w-3.5 h-3.5 opacity-50 hover:opacity-100 flex-shrink-0"
                onClick={(e) => { e.stopPropagation(); closeFile(file.path); }}
              />
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-primary">{activeFile.path.split('/').pop()}</span>
          {isJinja && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-accent-dim text-accent">Jinja2</span>
          )}
        </div>
        
        <div className="flex items-center gap-1">
          <button
            onClick={() => undoFile(activeFile.path)}
            disabled={activeFile.historyIndex <= 0}
            className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary disabled:opacity-30"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => redoFile(activeFile.path)}
            disabled={activeFile.historyIndex >= activeFile.history.length - 1}
            className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary disabled:opacity-30"
            title="Redo (Ctrl+Y)"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-accent hover:bg-accent-hover text-white transition-colors"
            title="Save (Ctrl+S)"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <Editor
          height="100%"
          defaultLanguage={isJinja ? 'jinja' : getFileType(activeFile.path)}
          theme="vs-dark"
          value={activeFile.content}
          onChange={handleEditorChange}
          onMount={handleEditorDidMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            padding: { top: 16, bottom: 16 },
          }}
        />
      </div>
    </div>
  );
}
