export interface FsNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FsNode[];
  content?: string;
}

export interface RawFsNode {
  name: string;
  isDir: boolean;
  children?: RawFsNode[];
}

export interface ScanFolderResult {
  name: string;
  children: RawFsNode[];
}

export function buildPaths(nodes: RawFsNode[], parentPath: string): FsNode[] {
  return nodes.map((node) => ({
    name: node.name,
    path: parentPath ? `${parentPath}/${node.name}` : node.name,
    isDir: node.isDir,
    children: node.children ? buildPaths(node.children, parentPath ? `${parentPath}/${node.name}` : node.name) : undefined,
  }));
}

export function getParentPath(node: FsNode): string {
  return node.isDir ? node.path : (node.path.lastIndexOf("/") > 0 ? node.path.substring(0, node.path.lastIndexOf("/")) : "");
}

// Custom MIME type for the drag payload \u2014 keeps us from accepting drags from
// other tabs/apps and from confusing browser-native file drags.
export const DRAG_MIME = "application/x-nightshift-tree-path";
