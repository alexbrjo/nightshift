import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Folder, FileText, Trash, Plus, ChevronRight, ChevronDown, FolderOpen } from 'lucide-react';
import { api } from '../api';
import { useProject } from '../hooks/useProject';
import type { ProjectFile } from '@shared/types';

interface TreeNode extends ProjectFile {
  children?: TreeNode[];
  loaded?: boolean;
}

function updateTree(nodes: TreeNode[], targetPath: string, children: ProjectFile[]): TreeNode[] {
  return nodes.map(n => {
    if (n.path === targetPath) {
      return { ...n, children: children.map(c => ({ ...c, loaded: !c.isDirectory })), loaded: true };
    }
    if (n.children) {
      return { ...n, children: updateTree(n.children, targetPath, children) };
    }
    return n;
  });
}

export default function FileExplorer() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { projectPath, refreshProject, openProject } = useProject();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newFilePath, setNewFilePath] = useState('');
  const [showNewInput, setShowNewInput] = useState(false);
  const [showOpenInput, setShowOpenInput] = useState(false);
  const [openPath, setOpenPath] = useState('');
  const [error, setError] = useState('');

  const loadDir = useCallback(async (dir: string) => {
    try {
      const res = await api.getFiles(dir);
      return res.files;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load files');
      return [];
    }
  }, []);

  const reloadRoot = useCallback(async () => {
    const files = await loadDir('');
    setTree(files.map(f => ({ ...f, loaded: !f.isDirectory })));
    setExpanded(new Set());
  }, [loadDir]);

  useEffect(() => {
    refreshProject();
    reloadRoot();
  }, [refreshProject, reloadRoot]);

  const toggleDir = async (node: TreeNode) => {
    if (!node.isDirectory) {
      navigate(`/?file=${encodeURIComponent(node.path)}`);
      return;
    }
    if (expanded.has(node.path)) {
      setExpanded(prev => {
        const next = new Set(prev);
        next.delete(node.path);
        return next;
      });
      return;
    }
    const children = await loadDir(node.path);
    setTree(prev => updateTree(prev, node.path, children));
    setExpanded(prev => new Set(prev).add(node.path));
  };

  const handleCreate = async () => {
    if (!newFilePath.trim()) return;
    try {
      await api.writeFile(newFilePath.trim(), '');
      setNewFilePath('');
      setShowNewInput(false);
      await reloadRoot();
      navigate(`/?file=${encodeURIComponent(newFilePath.trim())}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create file');
    }
  };

  const handleDelete = async (path: string) => {
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      await api.deleteFile(path);
      await reloadRoot();
      const currentFile = searchParams.get('file');
      if (currentFile === path) {
        navigate('/');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete file');
    }
  };

  const handleOpenProject = async () => {
    if (!openPath.trim()) return;
    try {
      await openProject(openPath.trim());
      setShowOpenInput(false);
      setOpenPath('');
      await reloadRoot();
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open project');
    }
  };

  const renderNode = (node: TreeNode, depth = 0) => {
    const isExpanded = expanded.has(node.path);
    const isSelected = searchParams.get('file') === node.path;
    const paddingLeft = depth * 12 + 8;

    return (
      <div key={node.path}>
        <div
          className={`group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-gray-800 ${isSelected ? 'bg-gray-800 text-blue-400' : 'text-gray-300'}`}
          style={{ paddingLeft }}
          onClick={() => toggleDir(node)}
        >
          {node.isDirectory ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span className="w-[14px]" />
          )}
          {node.isDirectory ? <Folder size={14} className="text-yellow-500 shrink-0" /> : <FileText size={14} className="text-gray-400 shrink-0" />}
          <span className="text-sm truncate flex-1 select-none">{node.name}</span>
          {!node.isDirectory && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(node.path); }}
              className="opacity-0 group-hover:opacity-100 hover:text-red-400 p-1 shrink-0"
            >
              <Trash size={12} />
            </button>
          )}
        </div>
        {node.isDirectory && isExpanded && node.children && (
          <div>
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-gray-900 border-r border-gray-700 w-64 shrink-0">
      <div className="p-2 border-b border-gray-700 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-gray-400">Files</span>
        <div className="flex gap-1">
          <button onClick={() => setShowOpenInput(!showOpenInput)} className="p-1 hover:bg-gray-700 rounded" title="Open project">
            <FolderOpen size={14} />
          </button>
          <button onClick={() => setShowNewInput(!showNewInput)} className="p-1 hover:bg-gray-700 rounded" title="New file">
            <Plus size={14} />
          </button>
        </div>
      </div>
      {projectPath && (
        <div className="px-2 py-1 text-[10px] text-gray-500 truncate border-b border-gray-700/50" title={projectPath}>
          {projectPath}
        </div>
      )}
      {error && <div className="px-2 py-1 text-xs text-red-400">{error}</div>}
      {showOpenInput && (
        <div className="p-2 flex gap-1">
          <input
            value={openPath}
            onChange={e => setOpenPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleOpenProject()}
            placeholder="/path/to/project"
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
          />
          <button onClick={handleOpenProject} className="px-2 py-1 bg-blue-600 rounded text-xs hover:bg-blue-500">Open</button>
        </div>
      )}
      {showNewInput && (
        <div className="p-2 flex gap-1">
          <input
            value={newFilePath}
            onChange={e => setNewFilePath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="path/to/file.txt"
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
          />
          <button onClick={handleCreate} className="px-2 py-1 bg-blue-600 rounded text-xs hover:bg-blue-500">Add</button>
        </div>
      )}
      <div className="flex-1 overflow-auto py-1">
        {tree.map(node => renderNode(node))}
      </div>
    </div>
  );
}
