import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '../types/tauri';
import { ChevronRight, ChevronDown, FileText, FolderOpen, Folder, Play, MoreVertical } from 'lucide-react';
import { useStore } from '../lib/store';

interface FileExplorerProps {
  entries: FileEntry[];
  loading: boolean;
  onOpenFile: (path: string) => void;
}

function getFileIcon(name: string, isDir: boolean) {
  if (isDir) return <Folder className="w-4 h-4 text-accent" />;
  
  const ext = name.split('.').pop()?.toLowerCase();
  const colors: Record<string, string> = {
    json: 'text-yellow-400',
    js: 'text-yellow-300',
    ts: 'text-blue-400',
    jsx: 'text-cyan-400',
    tsx: 'text-cyan-400',
    py: 'text-green-400',
    yaml: 'text-blue-300',
    yml: 'text-blue-300',
    csv: 'text-green-300',
    md: 'text-gray-400',
  };
  
  return <FileText className={`w-4 h-4 ${colors[ext || ''] || 'text-text-muted'}`} />;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function FileTreeItem({ entry, depth = 0 }: { entry: FileEntry; depth?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const { openFile } = useStore();

  const isDir = entry.type === 'dir';

  async function handleExpand() {
    if (isDir && !expanded) {
      setLoading(true);
      try {
        const result = await invoke<FileEntry[]>('list_directory', { path: entry.path });
        setChildren(result.filter(e => e.name !== '.nightshift'));
      } catch (err) {
        console.error('Failed to load directory:', err);
      } finally {
        setLoading(false);
        setExpanded(true);
      }
    } else if (!isDir && entry.type === 'file') {
      openFile(entry.path, '');
    }
  }

  return (
    <div>
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-1.5 py-1 px-2 hover:bg-bg-hover text-sm group transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isDir ? (
          expanded ? <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        ) : (
          <span className="w-3.5 h-3.5 flex-shrink-0" />
        )}
        
        {getFileIcon(entry.name, isDir)}
        
        <span className={`truncate ${isDir ? 'text-text-primary' : 'text-text-secondary'} group-hover:text-text-primary`}>
          {entry.name}
        </span>
        
        {!isDir && entry.size && (
          <span className="ml-auto text-xs text-text-muted">{formatSize(entry.size)}</span>
        )}
      </button>

      {expanded && children.length > 0 && (
        <div>
          {children.map(child => (
            <FileTreeItem key={child.path} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}

      {loading && (
        <div className="py-1 px-2" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
          <span className="text-xs text-text-muted">Loading...</span>
        </div>
      )}
    </div>
  );
}

export default function FileExplorer({ entries, loading }: FileExplorerProps) {
  const dirs = entries.filter(e => e.type === 'dir' && e.name !== '.nightshift');
  const files = entries.filter(e => e.type === 'file');

  if (loading) {
    return (
      <div className="w-64 border-r border-border flex items-center justify-center">
        <span className="text-sm text-text-muted">Loading project...</span>
      </div>
    );
  }

  return (
    <div className="w-64 border-r border-border flex flex-col bg-bg-secondary">
      <div className="px-3 py-2.5 border-b border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Explorer</h3>
      </div>

      <div className="flex-1 overflow-auto">
        {dirs.length > 0 && (
          <>
            <div className="px-3 py-1.5 text-xs font-medium text-text-muted">Folders</div>
            {dirs.map(dir => (
              <FileTreeItem key={dir.path} entry={dir} />
            ))}
          </>
        )}

        {files.length > 0 && (
          <>
            <div className="px-3 py-1.5 text-xs font-medium text-text-muted">Files</div>
            {files.map(file => (
              <FileTreeItem key={file.path} entry={file} />
            ))}
          </>
        )}

        {dirs.length === 0 && files.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className="text-sm text-text-muted">No files found</p>
            <p className="text-xs text-text-muted mt-1">Open a project to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}
