import { useState, useCallback } from "react";
import { MethodWorkspaceProvider } from "./features/agent/AgentWorkspace";
import { ToastProvider } from "./components/ui/Toast";
import ResourceSidebar from "./components/resources/ResourceSidebar";
import WorkspacePanels from "./components/workspace/WorkspacePanels";
import { createPanel } from "./layout";
import { useAppEvent } from "./appEvents";
import { useMethodExecutionLauncher } from "./hooks/useMethodExecutionLauncher";
import { useProjectFiles } from "./hooks/useProjectFiles";
import { useTheme } from "./hooks/useTheme";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";

export default function App() {
  const {
    layout,
    openPanel,
    replacePanelWithPanel,
    focusOrReplacePanel,
    setProjectEditorViewMode,
    setActiveResourceKind,
    toggleSidebar,
    setSplitSizes,
    setActivePanel,
    closeWorkspacePanel,
  } = useWorkspaceLayout();
  const {
    fileSnapshots,
    dirtyPaths,
    fileTreeRefreshKey,
    projectFolderName,
    setProjectFolderName,
    handleFileOpen,
    handleFileSaved,
    updateFileContent,
    getActiveContent,
  } = useProjectFiles({ panels: layout.panels, openPanel });
  const { isDark, toggleTheme } = useTheme();
  const {
    executingMethodPath,
    methodExecutionFeedback,
    executeMethodFile,
  } = useMethodExecutionLauncher(dirtyPaths);
  const [jobListRefreshKey, setJobListRefreshKey] = useState(0);

  const handleJobCreated = useCallback((jobId: number, sourcePanelId: string) => {
    setJobListRefreshKey((key) => key + 1);
    const jobPanel = createPanel("job-view", { resourceId: jobId, title: `Job #${jobId}` });
    replacePanelWithPanel(sourcePanelId, jobPanel);
  }, [replacePanelWithPanel]);

  useAppEvent("methodExecutionStarted", useCallback((detail) => {
    if (!detail?.executionId) return;
    const executionPanel = createPanel("method-execution", {
      resourceId: detail.executionId,
      title: detail.method?.title ? `Execution: ${detail.method.title}` : `Execution #${detail.executionId}`,
    });
    focusOrReplacePanel(executionPanel, detail.sourcePanelId);
  }, [focusOrReplacePanel]));

  return (
    <ToastProvider>
      <MethodWorkspaceProvider>
      <div className="app">
        <div className="topbar" data-tauri-drag-region>
          <span className="topbar-title" data-tauri-drag-region>Nightshift</span>
        </div>
        <div className="app-body">
          <ResourceSidebar
            layout={layout}
            isDark={isDark}
            projectFolderName={projectFolderName}
            fileTreeRefreshKey={fileTreeRefreshKey}
            jobListRefreshKey={jobListRefreshKey}
            dirtyPaths={dirtyPaths}
            onToggleTheme={toggleTheme}
            onSetActiveResourceKind={setActiveResourceKind}
            onToggleSidebar={toggleSidebar}
            onFileOpen={handleFileOpen}
            onFileSaved={handleFileSaved}
            getActiveContent={getActiveContent}
            onRootNameChange={setProjectFolderName}
            openPanel={openPanel}
          />
          <WorkspacePanels
            layout={layout}
            fileSnapshots={fileSnapshots}
            dirtyPaths={dirtyPaths}
            executingMethodPath={executingMethodPath}
            methodExecutionFeedback={methodExecutionFeedback}
            onSplitSizesChange={setSplitSizes}
            onSetActivePanel={setActivePanel}
            onClosePanel={closeWorkspacePanel}
            onProjectEditorViewModeChange={setProjectEditorViewMode}
            onProjectFileChange={updateFileContent}
            onExecuteMethodFile={(filePath, sourcePanelId) => void executeMethodFile(filePath, sourcePanelId)}
            onJobCreated={handleJobCreated}
          />
        </div>
      </div>
      </MethodWorkspaceProvider>
    </ToastProvider>
  );
}
