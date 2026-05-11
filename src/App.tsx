import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import Editor from "./components/Editor";
import FileTree, { type FsNode } from "./components/FileTree";
import AgentWorkspace from "./components/AgentWorkspace";
import JobRunnerPage from "./components/JobRunnerPage";
import CollectionViewer from "./components/CollectionViewer";
import CollectionsList from "./components/CollectionsList";
import { ToastProvider } from "./components/Toast";
import {
  DropperIcon,
  CabinetIcon,
  TestTubeIcon,
  RackIcon,
  MoonIcon,
} from "./components/icons";

type Section =
  | "code-editor"
  | "job-runner"
  | "experiment-designer"
  | "collection-viewer";

function getLanguage(filename: string): string | undefined {
  // Multi-extension files like `prompt.spec.jinja2` → use the FINAL extension.
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
  const [activeSection, setActiveSection] = useState<Section>("code-editor");
  const [activeFile, setActiveFile] = useState<{
    path: string;
    name: string;
    content: string;
    language?: string;
  } | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const fileContentsRef = useRef(new Map<string, string>());
  // Per-file disk content captured the first time a file is opened (and after
  // each save). A path is "dirty" iff its in-memory content differs from this
  // baseline; the dirty set drives the unsaved-marker in the file tree.
  const originalContentsRef = useRef(new Map<string, string>());
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());

  // Theme toggle: clicking the moon logo flips between the default lab theme
  // (no attribute) and the midnight theme (data-theme="dark"). Persisted to
  // localStorage so it survives reloads.
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

  const sections: { id: Section; icon: ReactNode; label: string }[] = [
    { id: "code-editor", icon: <DropperIcon />, label: "Project" },
    { id: "collection-viewer", icon: <CabinetIcon />, label: "Collections" },
    { id: "job-runner", icon: <TestTubeIcon />, label: "Inference Jobs" },
    {
      id: "experiment-designer",
      icon: <RackIcon />,
      label: "Agent",
    },
  ];

  const handleFileOpen = useCallback(async (node: FsNode) => {
    // Prefer the in-memory copy if we already have it — otherwise the user's
    // unsaved edits would get clobbered every time they revisit a file. The
    // node.content provided by FileTree is treated as disk truth and seeds
    // the original-content baseline for dirty detection.
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

  // Called by FileTree after a successful write_file. Re-baselines the saved
  // path so the dirty marker disappears.
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
        <div className="topbar" data-tauri-drag-region>
          <span className="topbar-title" data-tauri-drag-region>Nightshift</span>
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

        {/* FileTree always mounted so folder state persists across section switches */}
        <FileTree
          onFileOpen={handleFileOpen}
          onFileSaved={handleFileSaved}
          dirtyPaths={dirtyPaths}
          getActiveContent={(filePath) => fileContentsRef.current.get(filePath || activeFile?.path || "") ?? undefined}
          className={activeSection === "code-editor" ? "" : "hidden"}
        />

        {/* All section panes stay mounted so in-flight work (job listeners,
            polling, scroll positions) survives section switches. The inactive
            panes are hidden via display:none. */}
        <main className={`workspace${activeSection === "code-editor" ? "" : " hidden"}`}>
          {activeFile ? (
            <Editor
              code={activeFile.content}
              language={activeFile.language}
              onChange={(code) => {
                setActiveFile((prev) => {
                  if (!prev) return prev;
                  fileContentsRef.current.set(prev.path, code);
                  // Recompute dirty state for this path against its disk
                  // baseline; exits cleanly if the user typed back to the
                  // original content.
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

        <main className={`workspace job-runner-workspace full-width${activeSection === "job-runner" ? "" : " hidden"}`}>
          <JobRunnerPage
            isActive={activeSection === "job-runner"}
            onViewCollection={(collectionId) => {
              setSelectedCollectionId(collectionId);
              setActiveSection("collection-viewer");
            }}
          />
        </main>

        <main className={`workspace full-width collections-page${activeSection === "collection-viewer" ? "" : " hidden"}`}>
          <CollectionsList
            isActive={activeSection === "collection-viewer"}
            selectedId={selectedCollectionId}
            onSelectCollection={setSelectedCollectionId}
          />
          {selectedCollectionId ? (
            <CollectionViewer collectionId={selectedCollectionId} />
          ) : (
            <div className="collections-placeholder">
              <p>Select a collection to view its items.</p>
            </div>
          )}
        </main>

        <main className={`workspace full-width${activeSection === "experiment-designer" ? "" : " hidden"}`}>
          <AgentWorkspace />
        </main>
        </div>
      </div>
    </ToastProvider>
  );
}
