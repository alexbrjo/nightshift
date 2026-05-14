import { useState, useCallback, useEffect, type MouseEvent } from "react";
import ContextMenu from "../../components/ui/ContextMenu";
import InputDialog from "../../components/ui/InputDialog";
import { useToast } from "../../components/ui/Toast";
import TreeNode from "./TreeNode";
import { DRAG_MIME, buildPaths, getParentPath, type FsNode, type ScanFolderResult } from "./projectTreeModel";

export type { FsNode } from "./projectTreeModel";
type DialogType = "rename" | "newFile" | "newFolder";

// Stable empty fallback so FileTree's `dirtyPaths` prop can be optional
// without forcing the parent to memoize a new Set on every render.
const EMPTY_DIRTY: Set<string> = new Set();

export default function FileTree({
  onFileOpen,
  onFileSaved,
  dirtyPaths,
  getActiveContent,
  className = "",
  refreshKey = 0,
  onRootNameChange,
}: {
  onFileOpen: (node: FsNode) => void;
  onFileSaved?: (path: string) => void;
  dirtyPaths?: Set<string>;
  getActiveContent: (filePath?: string) => string | undefined;
  className?: string;
  refreshKey?: number;
  onRootNameChange?: (name: string) => void;
}) {
  const dirty = dirtyPaths ?? EMPTY_DIRTY;
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [rootName, setRootName] = useState("");
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Sentinel value "" represents the project root as a drop target.
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const { showToast } = useToast();

  const loadExpandedState = useCallback(async (path: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const paths: string[] = await invoke("load_expanded_state", { rootPath: path });
      setExpandedFolders(new Set(paths));
    } catch (err) {
      showToast(`Failed to load expanded state: ${err}`);
    }
  }, []);

  const saveExpandedState = useCallback(async (paths: string[]) => {
    if (!rootPath) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_expanded_state", { rootPath, paths });
    } catch (err) {
      showToast(`Failed to save expanded state: ${err}`);
    }
  }, [rootPath]);

  const toggleExpand = useCallback(async (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      saveExpandedState(Array.from(next));
      return next;
    });
  }, [saveExpandedState]);

  useEffect(() => {
    async function tryAutoOpen() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const lastPath: string | null = await invoke("load_last_folder");
        if (!lastPath) return;

        const result: ScanFolderResult = await invoke("scan_folder", { path: lastPath });
        setRootName(result.name);
        onRootNameChange?.(result.name);
        setRootPath(lastPath);
        setNodes(buildPaths(result.children, ""));
        await loadExpandedState(lastPath);
      } catch (err) {
        showToast(`Failed to open last folder: ${err}`);
      }
    }
    tryAutoOpen();
  }, [loadExpandedState, onRootNameChange]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: FsNode;
  } | null>(null);
  const [dialog, setDialog] = useState<{
    type: DialogType;
    node: FsNode;
    defaultValue: string;
  } | null>(null);

  const openFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open Folder",
      });

      if (!selected) return;

      const path = typeof selected === "string" ? selected : selected[0];
      if (!path) return;

      const { invoke } = await import("@tauri-apps/api/core");
      const result: ScanFolderResult = await invoke("scan_folder", { path });

      setRootName(result.name);
      onRootNameChange?.(result.name);
      setRootPath(path);
      setNodes(buildPaths(result.children, ""));
      setExpandedFolders(new Set());
      await invoke("save_last_folder", { path });
      await loadExpandedState(path);
    } catch (err) {
      showToast(`Failed to open folder: ${err}`);
    }
  }, [loadExpandedState, onRootNameChange]);

  const handleFileClick = useCallback(
    async (node: FsNode) => {
      if (node.isDir || !rootPath) return;

      try {
        const inMemoryContent = getActiveContent(node.path);
        if (inMemoryContent !== undefined) {
          onFileOpen({ ...node, content: inMemoryContent });
          return;
        }

        const { invoke } = await import("@tauri-apps/api/core");
        const content: string = await invoke("read_file", {
          relativePath: node.path,
        });
        onFileOpen({ ...node, content });
      } catch (err) {
        showToast(`Failed to read file: ${err}`);
      }
    },
    [onFileOpen, rootPath, getActiveContent],
  );

  const handleContextMenu = useCallback((e: MouseEvent, node: FsNode) => {
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const refreshTree = useCallback(async () => {
    if (!rootPath) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result: ScanFolderResult = await invoke("scan_folder", { path: rootPath });
      setRootName(result.name);
      onRootNameChange?.(result.name);
      setNodes(buildPaths(result.children, ""));
    } catch (err) {
      showToast(`Failed to refresh tree: ${err}`);
    }
  }, [rootPath, onRootNameChange]);

  useEffect(() => {
    if (refreshKey === 0) return;
    void refreshTree();
  }, [refreshKey, refreshTree]);

  const executeRename = useCallback(
    async (node: FsNode, newName: string) => {
      if (!rootPath || newName === node.name) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("rename_path", { relativePath: node.path, newName });
        await refreshTree();
      } catch (err) {
        showToast(`Failed to rename: ${err}`);
      }
    },
    [rootPath, refreshTree],
  );

  const executeNewFile = useCallback(
    async (node: FsNode, fileName: string) => {
      if (!rootPath) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const parentPath = getParentPath(node);
        await invoke("create_file", { parentRelativePath: parentPath, fileName });
        await refreshTree();
      } catch (err) {
        showToast(`Failed to create file: ${err}`);
      }
    },
    [rootPath, refreshTree],
  );

  const executeNewFolder = useCallback(
    async (node: FsNode, folderName: string) => {
      if (!rootPath) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const parentPath = getParentPath(node);
        await invoke("create_folder", { parentRelativePath: parentPath, folderName });
        await refreshTree();
      } catch (err) {
        showToast(`Failed to create folder: ${err}`);
      }
    },
    [rootPath, refreshTree],
  );

  const handleRename = useCallback((node: FsNode) => {
    setDialog({ type: "rename", node, defaultValue: node.name });
  }, []);

  const handleNewFile = useCallback((node: FsNode) => {
    setDialog({ type: "newFile", node, defaultValue: "new_file.txt" });
  }, []);

  const handleNewFolder = useCallback((node: FsNode) => {
    setDialog({ type: "newFolder", node, defaultValue: "new_folder" });
  }, []);

  const handleDelete = useCallback(
    async (node: FsNode) => {
      if (!rootPath) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const { ask } = await import("@tauri-apps/plugin-dialog");

        const confirmed = await ask(
          `Delete "${node.name}"${node.isDir ? " and all its contents" : ""}?`,
          { title: "Confirm Delete", kind: "warning" }
        );
        if (!confirmed) return;

        await invoke("delete_path", { relativePath: node.path });
        await refreshTree();
      } catch (err) {
        showToast(`Failed to delete: ${err}`);
      }
    },
    [rootPath, refreshTree],
  );

  const handleCopy = useCallback(
    async (node: FsNode) => {
      if (!rootPath || node.isDir) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("copy_file", { relativePath: node.path });
        await refreshTree();
      } catch (err) {
        showToast(`Failed to copy: ${err}`);
      }
    },
    [rootPath, refreshTree],
  );

  // Move a path from `sourcePath` to `targetParentPath` (empty string means
   // the project root). Refreshes the tree on success so the move is visible.
  const handleMove = useCallback(
    async (sourcePath: string, targetParentPath: string) => {
      if (!rootPath) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("move_path", {
          sourceRelativePath: sourcePath,
          targetParentRelativePath: targetParentPath,
        });
        await refreshTree();
      } catch (err) {
        showToast(`Failed to move: ${err}`);
      }
    },
    [rootPath],
  );

  const handleSave = useCallback(
    async (node: FsNode) => {
      if (!rootPath || node.isDir) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content = getActiveContent(node.path);
        if (content !== undefined) {
          await invoke("write_file", { relativePath: node.path, content });
          onFileSaved?.(node.path);
        }
      } catch (err) {
        showToast(`Failed to save: ${err}`);
      }
    },
    [rootPath, getActiveContent, onFileSaved],
  );

  const handleDialogSubmit = useCallback(
    async (value: string) => {
      if (!dialog) return;
      setDialog(null);

      switch (dialog.type) {
        case "rename":
          await executeRename(dialog.node, value);
          break;
        case "newFile":
          await executeNewFile(dialog.node, value);
          break;
        case "newFolder":
          await executeNewFolder(dialog.node, value);
          break;
      }
    },
    [dialog, executeRename, executeNewFile, executeNewFolder],
  );

  const buildMenuItems = (node: FsNode) => {
    const items: { label: string; action: () => void; danger?: boolean }[] = [];

    if (!node.isDir) {
      items.push({ label: "Open", action: () => handleFileClick(node) });
      items.push({ label: "Save", action: () => handleSave(node) });
    }

    items.push({ label: "Rename", action: () => handleRename(node) });

    if (!node.isDir) {
      items.push({ label: "Copy", action: () => handleCopy(node) });
    }

    items.push({ label: "Delete", action: () => handleDelete(node), danger: true });

    if (node.isDir) {
      items.push({ label: "New File...", action: () => handleNewFile(node) });
      items.push({ label: "New Folder...", action: () => handleNewFolder(node) });
    }

    return items;
  };

    return (
      <div className={`file-tree-panel ${className}`}>
        {rootPath === null ? (
          <div className="open-folder-prompt">
            <button className="open-folder-btn" onClick={openFolder}>
              Open Folder
            </button>
          </div>
        ) : (
          <>
            <div
              className={`tree-content${dragOverPath === "" ? " drop-target-root" : ""}`}
              onContextMenu={(e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  e.stopPropagation();
                  handleContextMenu(e, {
                    name: rootName,
                    path: rootPath ?? "",
                    isDir: true,
                  });
                }
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverPath !== "") setDragOverPath("");
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the container itself, not children.
                if (e.target === e.currentTarget) setDragOverPath(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverPath(null);
                const source = e.dataTransfer.getData(DRAG_MIME);
                if (source) handleMove(source, "");
              }}
            >
              {nodes.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  onFileClick={handleFileClick}
                  onContextMenu={handleContextMenu}
                  expandedFolders={expandedFolders}
                  onToggleExpand={toggleExpand}
                  dirtyPaths={dirty}
                  onMove={handleMove}
                  dragOverPath={dragOverPath}
                  setDragOverPath={setDragOverPath}
                />
              ))}
            </div>
          </>
        )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu.node)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {dialog && (
        <InputDialog
          title={dialog.type === "rename" ? "Rename" : dialog.type === "newFile" ? "New File" : "New Folder"}
          label={dialog.type === "rename" ? `New name for "${dialog.node.name}":` : dialog.type === "newFile" ? "File name:" : "Folder name:"}
          defaultValue={dialog.defaultValue}
          onSubmit={handleDialogSubmit}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
