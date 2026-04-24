export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface DirectoryContents {
  files: FileInfo[];
}
