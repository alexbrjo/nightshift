import {
  ChatPanel,
  DraftMethodGraphPanel,
  MethodExecutionGraphPanel,
} from "../../features/agent/AgentWorkspace";
import InferenceJobForm from "../../features/jobs/InferenceJobForm";
import JobViewPage from "../../features/jobs/JobViewPage";
import ProjectEditorPanel from "../../features/project-editor/ProjectEditorPanel";
import type { WorkspacePanel } from "../../layout";
import type { ProjectFileSnapshot } from "../../features/project-editor/projectFileModel";

export default function WorkspacePanelBody({
  panel,
  file,
  onProjectFileChange,
  onJobCreated,
}: {
  panel: WorkspacePanel;
  file?: ProjectFileSnapshot;
  onProjectFileChange: (path: string, content: string) => void;
  onJobCreated: (jobId: number, sourcePanelId: string) => void;
}) {
  switch (panel.type) {
    case "chat":
      return <ChatPanel chatId={panel.resourceId} />;
    case "method-graph":
      return <DraftMethodGraphPanel />;
    case "method-execution":
      return <MethodExecutionGraphPanel executionId={panel.resourceId} />;
    case "project-editor":
      return (
        <ProjectEditorPanel
          panel={panel}
          file={file}
          onChange={onProjectFileChange}
        />
      );
    case "job-view": {
      const jobId = Number(panel.resourceId);
      return Number.isFinite(jobId) ? (
        <div className="job-runner-main panel-job-view">
          <JobViewPage jobId={jobId} />
        </div>
      ) : (
        <div className="editor-placeholder">Select a job to view details.</div>
      );
    }
    case "new-job":
      return (
        <div className="job-runner-main panel-job-view">
          <InferenceJobForm
            isOpen={true}
            onClose={() => undefined}
            onSuccess={(jobId) => onJobCreated(jobId, panel.id)}
          />
        </div>
      );
  }
}
