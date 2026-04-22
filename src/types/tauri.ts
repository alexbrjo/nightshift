export interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size?: number;
  modified_at?: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}
