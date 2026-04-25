import { useState, useRef, useCallback, useEffect } from "react";

export interface FsNode {
  name: string;
  path: string;
  isDir: boolean;
  file?: File;
  children?: FsNode[];
}

const TEXT_EXTENSIONS = new Set([
  "js",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "csv",
  "md",
  "markdown",
  "txt",
  "jinja",
  "jinja2",
]);

function isTextFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? TEXT_EXTENSIONS.has(ext) : false;
}

function buildTree(files: File[]): FsNode[] {
  const textFiles = files.filter((f) => isTextFile(f.name));
  const nodeMap = new Map<string, FsNode>();

  for (const file of textFiles) {
    const parts = file.webkitRelativePath.split("/");

    for (let i = 0; i < parts.length - 1; i++) {
      const currentPath =
        (i === 0 ? "" : [...parts.slice(0, i).join("/"), "/"].join("")) +
        parts[i];
      if (!nodeMap.has(currentPath)) {
        nodeMap.set(currentPath, {
          name: parts[i],
          isDir: true,
          path: currentPath,
          children: [],
        });
      }
    }

    const filePath = file.webkitRelativePath;
    if (!nodeMap.has(filePath)) {
      nodeMap.set(filePath, {
        name: parts[parts.length - 1],
        isDir: false,
        path: filePath,
        file,
      });
    }
  }

  const roots: FsNode[] = [];
  for (const [path, node] of nodeMap) {
    const lastSlash = path.lastIndexOf("/");
    const parentPath = lastSlash > 0 ? path.substring(0, lastSlash) : "";

    if (parentPath && nodeMap.has(parentPath)) {
      const parentNode = nodeMap.get(parentPath)!;
      if (!parentNode.children!.some((c) => c.path === path)) {
        parentNode.children!.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  function sortNode(node: FsNode) {
    if (node.children && node.children.length > 0) {
      node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortNode);
    }
  }

  roots.forEach(sortNode);
  roots.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Return children of the root folder instead of the root itself
  const rootNode = roots.find((n) => n.isDir);
  if (rootNode && rootNode.children) {
    sortNode(rootNode);
    return rootNode.children;
  }

  return roots;
}

function TreeNode({
  node,
  depth,
  onFileClick,
}: {
  node: FsNode;
  depth: number;
  onFileClick: (node: FsNode) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!node.isDir && node.file) {
    return (
      <div
        className="tree-file"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onFileClick(node)}
      >
        <span className="file-icon">&#9675;</span>
        <span className="file-name">{node.name}</span>
      </div>
    );
  }

  if (node.isDir) {
    return (
      <div className="tree-folder">
        <button
          className="folder-header"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setExpanded(!expanded)}
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
            />
          ))}
      </div>
    );
  }

  return null;
}

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const fileList = Array.from(files);
      const firstPath = fileList[0].webkitRelativePath;
      setRootName(firstPath.split("/")[0]);
      setNodes(buildTree(fileList));
    },
    [],
  );

  return (
    <div className={`file-tree-panel ${className}`} style={style}>
      <input
        ref={inputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) =>
          handleFileChange(e as unknown as React.ChangeEvent<HTMLInputElement>)
        }
      />

      {nodes.length === 0 ? (
        <div className="open-folder-prompt">
          <button
            className="open-folder-btn"
            onClick={() => inputRef.current?.click()}
          >
            Open Folder
          </button>
        </div>
      ) : (
        <>
          <div className="tree-header">{rootName}</div>
          <div className="tree-content">
            {nodes.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                onFileClick={onFileOpen}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
