import { Fragment } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ProjectEditorHeaderActions } from "../../features/project-editor/ProjectEditorPanel";
import type { EditorViewMode, WorkspaceLayout } from "../../layout";
import type { ProjectFileSnapshot } from "../../features/project-editor/projectFileModel";
import EmptyWorkspace from "./EmptyWorkspace";
import WorkspacePanelBody from "./WorkspacePanelBody";

export default function WorkspacePanels({
  layout,
  fileSnapshots,
  dirtyPaths,
  executingMethodPath,
  methodExecutionFeedback,
  onSplitSizesChange,
  onSetActivePanel,
  onClosePanel,
  onProjectEditorViewModeChange,
  onProjectFileChange,
  onExecuteMethodFile,
  onJobCreated,
}: {
  layout: WorkspaceLayout;
  fileSnapshots: Record<string, ProjectFileSnapshot>;
  dirtyPaths: Set<string>;
  executingMethodPath: string | null;
  methodExecutionFeedback: Record<string, { tone: "success" | "error"; text: string }>;
  onSplitSizesChange: (splitSizes: number[]) => void;
  onSetActivePanel: (panelId: string) => void;
  onClosePanel: (panelId: string) => void;
  onProjectEditorViewModeChange: (panelId: string, viewMode: EditorViewMode) => void;
  onProjectFileChange: (path: string, content: string) => void;
  onExecuteMethodFile: (filePath: string, sourcePanelId: string) => void;
  onJobCreated: (jobId: number, sourcePanelId: string) => void;
}) {
  if (layout.panels.length === 0) {
    return (
      <main className="workspace panel-workspace">
        <EmptyWorkspace />
      </main>
    );
  }

  return (
    <main className="workspace panel-workspace">
      <PanelGroup
        id="nightshift-panel-workspace"
        direction="horizontal"
        className="workspace-panel-group"
        onLayout={onSplitSizesChange}
      >
        {layout.panels.map((panel, index) => {
          const file = panel.type === "project-editor" ? fileSnapshots[panel.resourceId ?? ""] : undefined;
          return (
            <Fragment key={panel.id}>
              {index > 0 && (
                <PanelResizeHandle
                  id={`workspace-panel-resize-${panel.id}`}
                  className="agent-pane-resizer"
                  aria-label={`Resize ${panel.title} panel`}
                />
              )}
              <Panel
                id={panel.id}
                order={index + 1}
                defaultSize={layout.splitSizes[index]}
                minSize={18}
                className={`workspace-panel ${layout.activePanelId === panel.id ? "active" : ""}`}
                onFocus={() => onSetActivePanel(panel.id)}
              >
                <section className="workspace-panel-shell" aria-label={panel.title}>
                  <header className="workspace-panel-header">
                    <div className="workspace-panel-header-main">
                      <button
                        type="button"
                        className="workspace-panel-title"
                        onClick={() => onSetActivePanel(panel.id)}
                        title={panel.resourceId ? `${panel.title} · ${panel.resourceId}` : panel.title}
                      >
                        {panel.title}
                      </button>
                      <ProjectEditorHeaderActions
                        panel={panel}
                        file={file}
                        isDirty={file ? dirtyPaths.has(file.path) : false}
                        isExecuting={file ? executingMethodPath === file.path : false}
                        feedback={file ? methodExecutionFeedback[file.path] : undefined}
                        onViewModeChange={onProjectEditorViewModeChange}
                        onExecute={onExecuteMethodFile}
                      />
                    </div>
                    <button
                      type="button"
                      className="workspace-panel-close"
                      onClick={() => onClosePanel(panel.id)}
                      title="Close panel"
                      aria-label={`Close ${panel.title}`}
                    >
                      ×
                    </button>
                  </header>
                  <div className="workspace-panel-body">
                    <WorkspacePanelBody
                      panel={panel}
                      file={file}
                      onProjectFileChange={onProjectFileChange}
                      onJobCreated={onJobCreated}
                    />
                  </div>
                </section>
              </Panel>
            </Fragment>
          );
        })}
      </PanelGroup>
    </main>
  );
}
