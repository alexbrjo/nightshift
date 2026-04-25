import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import MonacoEditor from '@monaco-editor/react';
import { api } from '../api';

function getLanguage(path: string): string {
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.json') || path.endsWith('.jsonl')) return 'json';
  if (path.endsWith('.csv')) return 'plaintext';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  if (path.endsWith('.jinja') || path.endsWith('.j2') || path.endsWith('.html')) return 'html';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.py')) return 'python';
  return 'plaintext';
}

export default function Editor() {
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get('file');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<any>(null);

  useEffect(() => {
    if (!filePath) {
      setContent('');
      setOriginalContent('');
      setStatus('idle');
      return;
    }
    setStatus('idle');
    api.readFile(filePath)
      .then(res => {
        setContent(res.content);
        setOriginalContent(res.content);
        setError('');
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : 'Failed to load file');
      });
  }, [filePath]);

  const saveFile = useCallback(async (value: string) => {
    if (!filePath) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus('saving');
    try {
      await api.writeFile(filePath, value);
      setOriginalContent(value);
      setContent(value);
      setStatus('saved');
    } catch (e) {
      setStatus('idle');
      setError(e instanceof Error ? e.message : 'Failed to save');
    }
  }, [filePath]);

  useEffect(() => {
    if (content === originalContent) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      saveFile(content);
    }, 1000);
    setStatus('idle');
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [content, originalContent, saveFile]);

  const handleManualSave = useCallback(() => {
    const current = editorRef.current?.getValue?.() ?? content;
    saveFile(current);
  }, [content, saveFile]);

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        Select a file from the explorer
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-gray-700 flex items-center justify-between bg-gray-800">
        <span className="text-sm text-gray-300 font-mono">{filePath}</span>
        <div className="flex items-center gap-3">
          <div className="text-xs">
            {status === 'saving' && <span className="text-yellow-400">Saving...</span>}
            {status === 'saved' && <span className="text-green-400">Saved</span>}
            {status === 'idle' && originalContent !== content && <span className="text-gray-500">Unsaved</span>}
          </div>
          <button
            onClick={handleManualSave}
            className="px-2 py-1 bg-blue-600 rounded text-xs hover:bg-blue-500"
          >
            Save
          </button>
        </div>
      </div>
      {error && <div className="px-4 py-2 text-xs text-red-400 bg-red-900/20">{error}</div>}
      <div className="flex-1 min-h-0">
        <MonacoEditor
          theme="vs-dark"
          language={getLanguage(filePath)}
          value={content}
          onChange={val => setContent(val || '')}
          onMount={(editor) => {
            editorRef.current = editor;
            (window as any).__monacoEditor = editor;
          }}
          options={{ minimap: { enabled: false }, automaticLayout: true }}
        />
      </div>
    </div>
  );
}
