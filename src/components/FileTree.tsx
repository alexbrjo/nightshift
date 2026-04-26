import { useState, useRef, useCallback } from "react";
import ContextMenu from "./ContextMenu";
import InputDialog from "./InputDialog";

export interface FsNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FsNode[];
  content?: string;
}

function buildPaths(nodes: any[], parentPath: string): FsNode[] {
  return nodes.map((node) => ({
    name: node.name,
    path: parentPath ? `${parentPath}/${node.name}` : node.name,
    isDir: node.isDir,
    children: node.children ? buildPaths(node.children, parentPath ? `${parentPath}/${node.name}` : node.name) : undefined,
  }));
}

function TreeNode({
  node,
  depth,
  onFileClick,
  onContextMenu,
}: {
  node: FsNode;
  depth: number;
  onFileClick: (node: FsNode) => void;
  onContextMenu: (e: React.MouseEvent, node: FsNode) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!node.isDir) {
    return (
      <div
        className="tree-file"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onFileClick(node)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node);
        }}
      >
        <span className="file-icon">&#9675;</span>
        <span className="file-name">{node.name}</span>
      </div>
    );
  }

  return (
    <div className="tree-folder">
      <button
        className="folder-header"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node);
        }}
      >
        <span className={`expand-icon ${expanded ? "open" : ""}`}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span className="folder-name">{node.name}</span>
      </button>
      {expanded &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onFileClick={onFileClick}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  );
}

type DialogType = "rename" | "newFile" | "newFolder";

export default function FileTree({
  onFileOpen,
  className = "",
  style,
}: {
  onFileOpen: (node: FsNode) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [rootName, setRootName] = useState("");
  const [rootPath, setRootPath] = useState<string | null>(null);
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
      const result: any = await invoke("scan_folder", { path });

      setRootName(result.name);
      setRootPath(path);
      setNodes(buildPaths(result.children, ""));
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  }, []);

  const handleFileClick = useCallback(
    async (node: FsNode) => {
      if (node.isDir || !rootPath) return;

      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content: string = await invoke("read_file", {
          relativePath: node.path,
        });
        onFileOpen({ ...node, content });
      } catch (err) {
        console.error("Failed to read file:", err);
      }
    },
    [onFileOpen, rootPath],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FsNode) => {
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const refreshTree = useCallback(async () => {
    if (!rootPath) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result: any = await invoke("scan_folder", { path: rootPath });
      setNodes(buildPaths(result.children, ""));
    } catch (err) {
      console.error("Failed to refresh tree:", err);
    }
  }, [rootPath]);

  const executeRename = useCallback(
    async (node: FsNode, newName: string) => {
      if (!rootPath || newName === node.name) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("rename_path", { relativePath: node.path, newName });
        await refreshTree();
      } catch (err) {
        console.error("Failed to rename:", err);
      }
    },
    [rootPath, refreshTree],
  );

  const executeNewFile = useCallback(
    async (node: FsNode, fileName: string) => {
      if (!rootPath) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const parentPath = node.isDir ? node.path : (node.path.lastIndexOf("/") > 0 ? node.path.substring(0, node.path.lastIndexOf("/")) : "");
        await invoke("create_file", { parentRelativePath: parentPath, fileName });
        await refreshTree();
      } catch (err) {
        console.error("Failed to create file:", err);
      }
    },
    [rootPath, refreshTree],
  );

  const executeNewFolder = useCallback(
    async (node: FsNode, folderName: string) => {
      if (!rootPath) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const parentPath = node.isDir ? node.path : (node.path.lastIndexOf("/") > 0 ? node.path.substring(0, node.path.lastIndexOf("/")) : "");
        await invoke("create_folder", { parentRelativePath: parentPath, folderName });
        await refreshTree();
      } catch (err) {
        console.error("Failed to create folder:", err);
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
        console.error("Failed to delete:", err);
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
        console.error("Failed to copy:", err);
      }
    },
    [rootPath, refreshTree],
  );

  const handleSave = useCallback(
    async (node: FsNode) => {
      if (!rootPath || node.isDir) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const content = (window as any).__nightshiftActiveContent;
        if (content !== undefined) {
          await invoke("write_file", { relativePath: node.path, content });
        }
      } catch (err) {
        console.error("Failed to save:", err);
      }
    },
    [rootPath],
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
    <div className={`file-tree-panel ${className}`} style={style}>
      {nodes.length === 0 ? (
        <div className="open-folder-prompt">
          <button className="open-folder-btn" onClick={openFolder}>
            Open Folder
          </button>
        </div>
      ) : (
        <>
          <div className="tree-header">{rootName}</div>
          <div
            className="tree-content"
            onContextMenu={(e) => {
              if (e.target === e.currentTarget) {
                e.preventDefault();
              }
            }}
          >
            {nodes.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                onFileClick={handleFileClick}
                onContextMenu={handleContextMenu}
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
