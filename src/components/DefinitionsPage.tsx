import { useCallback, useState } from "react";

import DefinitionForm from "./DefinitionForm";
import DefinitionTreeSidebar from "./DefinitionTreeSidebar";
import ExecutionViewPage from "./ExecutionViewPage";

interface DefinitionsPageProps {
  isActive?: boolean;
}

/**
 * Definitions section: tree sidebar on the left, per-node form on the right.
 * The Run button still lives on the form during commit A; commit B moves it
 * out entirely so executions are exclusively driven from the Job Executions
 * section.
 */
export default function DefinitionsPage({ isActive = true }: DefinitionsPageProps) {
  const [selectedDefId, setSelectedDefId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runExecId, setRunExecId] = useState<number | null>(null);

  const handleSaved = useCallback((defId: number) => {
    setSelectedDefId(defId);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSelect = useCallback((id: number) => {
    setSelectedDefId(id);
    setRunExecId(null);
  }, []);

  const handleDeleted = useCallback(() => {
    setSelectedDefId(null);
    setRunExecId(null);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleCancel = useCallback(() => {
    setRunExecId(null);
  }, []);

  const handleRunStarted = useCallback((execId: number) => {
    setRunExecId(execId);
  }, []);

  const handleBackFromExecution = useCallback(() => {
    setRunExecId(null);
  }, []);

  return (
    <div className="job-runner-page">
      <DefinitionTreeSidebar
        selectedId={selectedDefId}
        onSelectDefinition={handleSelect}
        refreshKey={refreshKey}
        isActive={isActive}
        title="Definitions"
      />
      <div className="job-runner-main">
        {runExecId !== null ? (
          <ExecutionViewPage
            key={runExecId}
            rootExecId={runExecId}
            onBack={handleBackFromExecution}
          />
        ) : selectedDefId === null ? (
          <div className="editor-placeholder">
            Select a definition or create a new one to get started.
          </div>
        ) : (
          <DefinitionForm
            key={selectedDefId}
            defId={selectedDefId}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onCancel={handleCancel}
            onRunStarted={handleRunStarted}
          />
        )}
      </div>
    </div>
  );
}
