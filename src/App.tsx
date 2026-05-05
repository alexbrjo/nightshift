import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import Editor from "./components/Editor";
import FileTree, { type FsNode } from "./components/FileTree";
import DefinitionsPage from "./components/DefinitionsPage";
import { ToastProvider } from "./components/Toast";
import {
  DropperIcon,
  RackIcon,
  TestTubeIcon,
  MoonIcon,
} from "./components/icons";

type Section = "definitions" | "job-executions" | "files";

function getLanguage(filename: string): string | undefined {
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

export default function App() {
  const [activeSection, setActiveSection] = useState<Section>("definitions");
  const [activeFile, setActiveFile] = useState<{
    path: string;
    name: string;
    content: string;
    language?: string;
  } | null>(null);
  const fileContentsRef = useRef(new Map<string, string>());
  const originalContentsRef = useRef(new Map<string, string>());
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());

  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("nightshift-theme") === "dark";
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("nightshift-theme", "dark");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("nightshift-theme");
    }
  }, [isDark]);

  // Section order: Definitions (the primary authoring surface), then Job
  // Executions (where you watch experiments run), then Files (project
  // file-system view for editing prompts/evals/scripts). Job Executions
  // lands in commit C; until then it shows a placeholder.
  const sections: { id: Section; icon: ReactNode; label: string }[] = [
    { id: "definitions", icon: <RackIcon />, label: "Definitions" },
    { id: "job-executions", icon: <TestTubeIcon />, label: "Job Executions" },
    { id: "files", icon: <DropperIcon />, label: "Files" },
  ];

  const handleFileOpen = useCallback(async (node: FsNode) => {
    const diskContent = node.content || "";
    const existing = fileContentsRef.current.get(node.path);
    const content = existing !== undefined ? existing : diskContent;

    fileContentsRef.current.set(node.path, content);
    if (!originalContentsRef.current.has(node.path)) {
      originalContentsRef.current.set(node.path, diskContent);
    }
    setActiveFile({
      path: node.path,
      name: node.name,
      content,
      language: getLanguage(node.name),
    });
  }, []);

  const handleFileSaved = useCallback((path: string) => {
    const current = fileContentsRef.current.get(path) ?? "";
    originalContentsRef.current.set(path, current);
    setDirtyPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  return (
    <ToastProvider>
      <div className="app">
        <div className="topbar">
          <span className="topbar-title">Nightshift</span>
        </div>
        <div className="app-body">
          <aside className="sidebar">
            <button
              type="button"
              className="sidebar-logo"
              title={isDark ? "Switch to lab theme" : "Switch to midnight theme"}
              aria-pressed={isDark}
              onClick={() => setIsDark((prev) => !prev)}
            >
              <MoonIcon />
            </button>
            <nav className="sidebar-nav">
              {sections.map((section) => (
                <button
                  key={section.id}
                  className={`sidebar-btn ${activeSection === section.id ? "active" : ""}`}
                  onClick={() => setActiveSection(section.id)}
                  title={section.label}
                >
                  <span>{section.icon}</span>
                </button>
              ))}
            </nav>
          </aside>

          <FileTree
            onFileOpen={handleFileOpen}
            onFileSaved={handleFileSaved}
            dirtyPaths={dirtyPaths}
            getActiveContent={(filePath) =>
              fileContentsRef.current.get(filePath || activeFile?.path || "") ?? undefined
            }
            className={activeSection === "files" ? "" : "hidden"}
          />

          <main
            className={`workspace${activeSection === "files" ? "" : " hidden"}`}
          >
            {activeFile ? (
              <Editor
                code={activeFile.content}
                language={activeFile.language}
                onChange={(code) => {
                  setActiveFile((prev) => {
                    if (!prev) return prev;
                    fileContentsRef.current.set(prev.path, code);
                    const original = originalContentsRef.current.get(prev.path) ?? "";
                    const path = prev.path;
                    setDirtyPaths((d) => {
                      const isDirty = code !== original;
                      if (isDirty === d.has(path)) return d;
                      const next = new Set(d);
                      if (isDirty) next.add(path);
                      else next.delete(path);
                      return next;
                    });
                    return { ...prev, content: code };
                  });
                }}
              />
            ) : (
              <div className="editor-placeholder">
                Open a folder and select a file to begin
              </div>
            )}
          </main>

          <main
            className={`workspace job-runner-workspace full-width${
              activeSection === "definitions" ? "" : " hidden"
            }`}
          >
            <DefinitionsPage isActive={activeSection === "definitions"} />
          </main>

          {activeSection === "job-executions" && (
            <main className="workspace full-width">
              <div className="editor-placeholder">
                Job Executions page lands in commit C.
              </div>
            </main>
          )}
        </div>
      </div>
    </ToastProvider>
  );
}
