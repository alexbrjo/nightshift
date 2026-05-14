import Editor from "./Editor";
import {
  MarkdownPreview,
  MethodGraphPreview,
  projectFileViewOptions,
} from "./ProjectFileViews";
import {
  CodeViewIcon,
  MarkdownViewIcon,
  MethodGraphViewIcon,
} from "../../components/ui/icons";
import type { EditorViewMode, WorkspacePanel } from "../../layout";
import {
  defaultViewModeForFile,
  isMethodSourceFile,
  type ProjectFileSnapshot,
} from "./projectFileModel";

function viewModeIcon(mode: EditorViewMode) {
  switch (mode) {
    case "code":
      return <CodeViewIcon />;
    case "markdown":
      return <MarkdownViewIcon />;
    case "methodGraph":
      return <MethodGraphViewIcon />;
  }
}

function selectedViewMode(panel: WorkspacePanel, file: ProjectFileSnapshot) {
  const defaultMode = defaultViewModeForFile(file.path, file.name) ?? "code";
  const requestedMode = panel.viewMode ?? defaultMode;
  return projectFileViewOptions(file.path, file.name).some((option) => option.mode === requestedMode)
    ? requestedMode
    : "code";
}

export function ProjectEditorHeaderActions({
  panel,
  file,
  isDirty,
  isExecuting,
  feedback,
  onViewModeChange,
  onExecute,
}: {
  panel: WorkspacePanel;
  file?: ProjectFileSnapshot;
  isDirty: boolean;
  isExecuting: boolean;
  feedback?: { tone: "success" | "error"; text: string };
  onViewModeChange: (panelId: string, viewMode: EditorViewMode) => void;
  onExecute: (filePath: string, sourcePanelId: string) => void;
}) {
  if (panel.type !== "project-editor" || !file) return null;
  const options = projectFileViewOptions(file.path, file.name);
  const viewMode = selectedViewMode(panel, file);
  const showExecute = viewMode === "methodGraph" && isMethodSourceFile(file.path, file.name);
  const executeTitle = isDirty ? "Save this Method file before execution" : "Execute Method file";

  return (
    <>
      {options.length > 1 && (
        <div className="project-file-view-switcher" role="group" aria-label={`View options for ${file.name}`}>
          {options.map((option) => (
            <button
              key={option.mode}
              type="button"
              className={`project-file-view-button ${viewMode === option.mode ? "active" : ""}`}
              onClick={() => onViewModeChange(panel.id, option.mode)}
              title={option.label}
              aria-label={`Show ${option.label} for ${file.name}`}
              aria-pressed={viewMode === option.mode}
            >
              {viewModeIcon(option.mode)}
            </button>
          ))}
        </div>
      )}
      {showExecute && (
        <>
          <button
            type="button"
            className="project-file-execute-button"
            onClick={() => onExecute(file.path, panel.id)}
            disabled={isDirty || isExecuting}
            title={executeTitle}
            aria-label={isDirty ? `Save ${file.name} before execution` : `Execute ${file.name}`}
          >
            {isExecuting ? "Starting" : "Execute"}
          </button>
          {feedback && (
            <span className={`project-file-execution-feedback ${feedback.tone}`} role="status">
              {feedback.text}
            </span>
          )}
        </>
      )}
    </>
  );
}

export default function ProjectEditorPanel({
  panel,
  file,
  onChange,
}: {
  panel: WorkspacePanel;
  file?: ProjectFileSnapshot;
  onChange: (path: string, content: string) => void;
}) {
  if (!file) {
    return <div className="editor-placeholder">Open this file from the Project sidebar to load its content.</div>;
  }
  if (file.error) {
    return <div className="editor-placeholder">Could not load {file.name}: {file.error}</div>;
  }

  const viewMode = selectedViewMode(panel, file);
  if (viewMode === "markdown") return <MarkdownPreview content={file.content} />;
  if (viewMode === "methodGraph") return <MethodGraphPreview content={file.content} />;

  return (
    <Editor
      code={file.content}
      language={file.language}
      onChange={(code) => onChange(file.path, code)}
    />
  );
}
