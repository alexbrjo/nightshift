import { useState, useCallback, useRef, type ReactNode } from "react";
import Editor from "./components/Editor";
import FileTree, { type FsNode } from "./components/FileTree";
import UnderConstruction from "./components/UnderConstruction";
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

const SECTION_LABELS: Record<Section, string> = {
  "code-editor": "Project",
  "job-runner": "Inference Jobs",
  "experiment-designer": "Agent",
  "collection-viewer": "Collections",
};

function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    json: "json",
    jsonl: "json",
    md: "markdown",
    markdown: "markdown",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    rs: "rust",
    html: "html",
    css: "css",
    sh: "bash",
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
    const content = node.content || "";
    fileContentsRef.current.set(node.path, content);
    setActiveFile({
      path: node.path,
      name: node.name,
      content,
      language: getLanguage(node.name),
    });
  }, []);

  return (
    <ToastProvider>
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-logo" title="Nightshift"><MoonIcon /></div>
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
                  if (prev) {
                    fileContentsRef.current.set(prev.path, code);
                    return { ...prev, content: code };
                  }
                  return prev;
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
          <JobRunnerPage />
        </main>

        <main className={`workspace full-width collections-page${activeSection === "collection-viewer" ? "" : " hidden"}`}>
          <CollectionsList
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

        {activeSection === "experiment-designer" && (
          <main className="workspace full-width">
            <UnderConstruction title={SECTION_LABELS[activeSection]} />
          </main>
        )}
      </div>
    </ToastProvider>
  );
}
