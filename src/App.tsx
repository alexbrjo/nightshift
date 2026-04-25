import { useState, useCallback } from "react";
import Editor from "./components/Editor";
import FileTree, { type FsNode } from "./components/FileTree";
import UnderConstruction from "./components/UnderConstruction";

type Section = "code-editor" | "collection-viewer" | "job-runner" | "experiment-designer";

const SECTION_LABELS: Record<Section, string> = {
  "code-editor": "Code Editor",
  "collection-viewer": "Collection Viewer",
  "job-runner": "Job Runner",
  "experiment-designer": "Experiment Designer",
};

function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    py: "python",
    html: "html",
    css: "css",
    json: "json",
    md: "markdown",
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

  const sections: { id: Section; icon: string; label: string }[] = [
    { id: "code-editor", icon: "&#9998;", label: "Code Editor" },
    { id: "collection-viewer", icon: "&#128457;", label: "Collection Viewer" },
    { id: "job-runner", icon: "&#9658;", label: "Job Runner" },
    { id: "experiment-designer", icon: "&#9830;", label: "Experiment Designer" },
  ];

  const handleFileOpen = useCallback(async (node: FsNode) => {
    if (!node.file) return;
    try {
      const content = await node.file.text();
      setActiveFile({
        path: node.path,
        name: node.name,
        content,
        language: getLanguage(node.name),
      });
    } catch {
      setActiveFile({
        path: node.path,
        name: node.name,
        content: "// Unable to read file",
        language: undefined,
      });
    }
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">&#9789;</div>
        <nav className="sidebar-nav">
          {sections.map((section) => (
            <button
              key={section.id}
              className={`sidebar-btn ${activeSection === section.id ? "active" : ""}`}
              onClick={() => setActiveSection(section.id)}
              title={section.label}
            >
              <span dangerouslySetInnerHTML={{ __html: section.icon }} />
            </button>
          ))}
        </nav>
      </aside>

      {activeSection === "code-editor" ? (
        <main className="workspace">
          <FileTree onFileOpen={handleFileOpen} />
          {activeFile ? (
            <Editor
              code={activeFile.content}
              language={activeFile.language}
              onChange={(code) => {
                setActiveFile((prev) => (prev ? { ...prev, content: code } : prev));
              }}
            />
          ) : (
            <div className="editor-placeholder">Open a folder and select a file to begin</div>
          )}
        </main>
      ) : (
        <main className="workspace full-width">
          <UnderConstruction title={SECTION_LABELS[activeSection]} />
        </main>
      )}
    </div>
  );
}
