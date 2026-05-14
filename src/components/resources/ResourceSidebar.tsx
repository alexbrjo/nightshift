import FileTree, { type FsNode } from "../../features/project-tree/FileTree";
import JobListSidebar from "../../features/jobs/JobListSidebar";
import type { EditorViewMode, PanelType, ResourceKind, WorkspaceLayout } from "../../layout";
import ConversationResources from "./ConversationResources";
import ResourceNav, { RESOURCE_BUTTONS } from "./ResourceNav";

type OpenPanel = (
  type: PanelType,
  options?: { resourceId?: string | number | null; title?: string; viewMode?: EditorViewMode },
) => void;

export default function ResourceSidebar({
  layout,
  isDark,
  projectFolderName,
  fileTreeRefreshKey,
  jobListRefreshKey,
  dirtyPaths,
  onToggleTheme,
  onSetActiveResourceKind,
  onToggleSidebar,
  onFileOpen,
  onFileSaved,
  getActiveContent,
  onRootNameChange,
  openPanel,
}: {
  layout: WorkspaceLayout;
  isDark: boolean;
  projectFolderName: string;
  fileTreeRefreshKey: number;
  jobListRefreshKey: number;
  dirtyPaths: Set<string>;
  onToggleTheme: () => void;
  onSetActiveResourceKind: (kind: ResourceKind) => void;
  onToggleSidebar: () => void;
  onFileOpen: (node: FsNode) => void;
  onFileSaved: (path: string) => void;
  getActiveContent: (filePath?: string) => string | undefined;
  onRootNameChange: (name: string) => void;
  openPanel: OpenPanel;
}) {
  const activeResource = RESOURCE_BUTTONS.find((resource) => resource.kind === layout.activeResourceKind);

  const renderResourceBrowser = () => {
    switch (layout.activeResourceKind) {
      case "conversation":
        return (
          <ConversationResources
            openPanelIds={new Set(layout.panels.map((panel) => panel.id))}
            onOpenChat={(chatId, title) => openPanel("chat", { resourceId: chatId, title: title ?? "Chat" })}
          />
        );
      case "method":
        return <p className="resource-empty-copy">Open Method source files from the project tree.</p>;
      case "project":
        return (
          <FileTree
            onFileOpen={onFileOpen}
            onFileSaved={onFileSaved}
            dirtyPaths={dirtyPaths}
            getActiveContent={getActiveContent}
            className="resource-file-tree"
            refreshKey={fileTreeRefreshKey}
            onRootNameChange={onRootNameChange}
          />
        );
      case "job":
        return (
          <JobListSidebar
            selectedId={null}
            onSelectJob={(jobId) => openPanel("job-view", { resourceId: jobId, title: `Job #${jobId}` })}
            onNewJob={() => openPanel("new-job")}
            refreshKey={jobListRefreshKey}
            isActive={layout.activeResourceKind === "job"}
          />
        );
    }
  };

  return (
    <>
      <ResourceNav
        sidebarMode={layout.sidebarMode}
        activeResourceKind={layout.activeResourceKind}
        isDark={isDark}
        onToggleTheme={onToggleTheme}
        onSetActiveResourceKind={onSetActiveResourceKind}
        onToggleSidebar={onToggleSidebar}
      />

      {layout.sidebarMode === "expanded" && (
        <aside className="resource-sidebar-panel">
          <header className="resource-sidebar-header">
            <h2>{activeResource?.label}</h2>
            {layout.activeResourceKind === "project" && projectFolderName && (
              <span
                className="resource-sidebar-context"
                title={projectFolderName}
                aria-label={`Project folder: ${projectFolderName}`}
              >
                {projectFolderName}
              </span>
            )}
          </header>
          {renderResourceBrowser()}
        </aside>
      )}
    </>
  );
}
