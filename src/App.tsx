import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from './types/tauri';
import Sidebar from './components/Sidebar';
import FileExplorer from './components/FileExplorer';
import CodeEditor from './components/CodeEditor';
import BulkInference from './components/BulkInference';
import BulkJavaScript from './components/BulkJavaScript';
import CollectionsView from './components/CollectionsView';
import PipelineEditor from './components/PipelineEditor';
import AnalysisAgents from './components/AnalysisAgents';
import { useStore } from './lib/store';

function invokeCmd<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke(cmd, args ?? {});
}

export default function App() {
  const { activeView, openFile, setFileTree } = useStore();
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadProjectFiles(path: string) {
    setLoading(true);
    try {
      const entries = await invokeCmd<FileEntry[]>('list_directory', { path });
      setFileEntries(entries);
      
      // Build file tree for explorer
      const tree = buildTree(entries, path);
      setFileTree(tree);
    } catch (err) {
      console.error('Failed to load project files:', err);
    } finally {
      setLoading(false);
    }
  }

  function buildTree(entries: FileEntry[], rootPath: string): FileNode[] {
    const nodes: Record<string, FileNode> = {};
    
    for (const entry of entries) {
      const isDir = entry.type === 'dir';
      nodes[entry.path] = {
        path: entry.path,
        name: entry.name,
        type: isDir ? 'directory' : 'file',
        size: entry.size,
        modifiedAt: entry.modified_at?.toString(),
        children: [],
      };
    }
    
    const roots: FileNode[] = [];
    for (const [path, node] of Object.entries(nodes)) {
      if (path === rootPath) continue;
      
      const parentPath = path.substring(0, path.lastIndexOf('/'));
      if (!parentPath || !nodes[parentPath]) {
        roots.push(node);
      } else {
        nodes[parentPath].children!.push(node);
      }
    }
    
    return roots.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
  }

  async function handleOpenFile(filePath: string) {
    try {
      const content = await invokeCmd<string>('read_file', { path: filePath });
      openFile(filePath, content);
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  }

  return (
    <div className="flex h-screen w-screen bg-bg-primary text-text-primary">
      <Sidebar />
      <div className="flex flex-1 overflow-hidden">
        <FileExplorer
          entries={fileEntries}
          loading={loading}
          onOpenFile={handleOpenFile}
        />
        
        {activeView === 'inference' || activeView === 'javascript' || activeView === 'collections' || activeView === 'pipelines' || activeView === 'agents' ? (
          <div className="flex-1 overflow-auto p-6">
            {activeView === 'inference' && <BulkInference />}
            {activeView === 'javascript' && <BulkJavaScript />}
            {activeView === 'collections' && <CollectionsView />}
            {activeView === 'pipelines' && <PipelineEditor />}
            {activeView === 'agents' && <AnalysisAgents />}
          </div>
        ) : (
          <CodeEditor />
        )}
      </div>
    </div>
  );
}
