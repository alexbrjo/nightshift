/// <reference types="vite/client" />

declare module '*.css' {
  const classes: Record<string, string>;
  export default classes;
}

interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
}
