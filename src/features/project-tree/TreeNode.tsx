import type { DragEvent, MouseEvent } from "react";
import { DRAG_MIME, type FsNode } from "./projectTreeModel";

export default function TreeNode({
  node,
  depth,
  onFileClick,
  onContextMenu,
  expandedFolders,
  onToggleExpand,
  dirtyPaths,
  onMove,
  dragOverPath,
  setDragOverPath,
}: {
  node: FsNode;
  depth: number;
  onFileClick: (node: FsNode) => void;
  onContextMenu: (e: MouseEvent, node: FsNode) => void;
  expandedFolders: Set<string>;
  onToggleExpand: (path: string) => void;
  dirtyPaths: Set<string>;
  onMove: (sourcePath: string, targetParentPath: string) => void;
  dragOverPath: string | null;
  setDragOverPath: (path: string | null) => void;
}) {
  const expanded = node.isDir ? expandedFolders.has(node.path) : false;

  const handleDragStart = (e: DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(DRAG_MIME, node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  if (!node.isDir) {
    const isDirty = dirtyPaths.has(node.path);
    return (
      <div
        className={`tree-file${isDirty ? " dirty" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 16}px` }}
        draggable={true}
        onDragStart={handleDragStart}
        onClick={() => onFileClick(node)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node);
        }}
      >
        <span className="file-icon">&#9675;</span>
        <span className="file-name">{node.name}</span>
        {isDirty && <span className="file-dirty-marker" aria-label="unsaved changes">{"\u25CF"}</span>}
      </div>
    );
  }

  // Folder: drop target lives on the WRAPPER, not the header button \u2014 buttons
  // can swallow drag events on Webkit and we want the folder's expanded
  // children area to accept drops too. innermost-wins via stopPropagation.
  const isDropTarget = dragOverPath === node.path;
  return (
    <div
      className={`tree-folder${isDropTarget ? " drop-target" : ""}`}
      onDragOver={(e) => {
        e.preventDefault(); // mark this element as a valid drop target
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (dragOverPath !== node.path) setDragOverPath(node.path);
      }}
      onDragLeave={(e) => {
        // Only clear when actually leaving the folder element, not when
        // moving from header \u2192 child.
        if (e.currentTarget === e.target && dragOverPath === node.path) {
          setDragOverPath(null);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOverPath(null);
        const source = e.dataTransfer.getData(DRAG_MIME);
        if (source && source !== node.path) onMove(source, node.path);
      }}
    >
      <button
        className="folder-header"
        style={{ paddingLeft: `${depth * 14 + 16}px` }}
        draggable={true}
        onDragStart={handleDragStart}
        onClick={() => onToggleExpand(node.path)}
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
        {isDropTarget && <span className="drop-target-arrow" aria-hidden="true">{"\u2937"}</span>}
      </button>
      {expanded &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onFileClick={onFileClick}
            onContextMenu={onContextMenu}
            expandedFolders={expandedFolders}
            onToggleExpand={onToggleExpand}
            dirtyPaths={dirtyPaths}
            onMove={onMove}
            dragOverPath={dragOverPath}
            setDragOverPath={setDragOverPath}
          />
        ))}
    </div>
  );
}
