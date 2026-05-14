import type { EditorViewMode } from "../../layout";

export interface ProjectFileSnapshot {
  path: string;
  name: string;
  content: string;
  language?: string;
  error?: string;
}

export function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    json: "json",
    jsonl: "json",
    ndjson: "json",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    rs: "rust",
    html: "html",
    htm: "html",
    css: "css",
    sh: "bash",
    bash: "bash",
    jinja2: "jinja2",
    jinja: "jinja2",
    j2: "jinja2",
    prompt: "jinja2",
  };
  return ext ? map[ext] : undefined;
}

export function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function isMethodSourceFile(path: string, name: string) {
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
  const normalizedName = name.toLowerCase();
  return normalizedName.endsWith(".method.yaml")
    || normalizedName.endsWith(".method.yml")
    || normalizedPath.endsWith(".method.yaml")
    || normalizedPath.endsWith(".method.yml");
}

export function defaultViewModeForFile(path: string, name: string): EditorViewMode | undefined {
  return isMethodSourceFile(path, name) ? "methodGraph" : undefined;
}
