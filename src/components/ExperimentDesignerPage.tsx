import { useState, useCallback } from "react";

import DefinitionForm from "./DefinitionForm";
import DefinitionListSidebar from "./DefinitionListSidebar";
import ExecutionViewPage from "./ExecutionViewPage";

interface ExperimentDesignerPageProps {
  isActive?: boolean;
}

export default function ExperimentDesignerPage({
  isActive = true,
}: ExperimentDesignerPageProps) {
  const [selectedDefId, setSelectedDefId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // When set, the right pane swaps from the form to ExecutionViewPage. Null
  // means we're in design mode. Selecting a different definition or clicking
  // "Back" in ExecutionViewPage clears it.
  const [runExecId, setRunExecId] = useState<number | null>(null);

  const handleSaved = useCallback((defId: number) => {
    setSelectedDefId(defId);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleNew = useCallback(() => {
    setSelectedDefId(null);
    setRunExecId(null);
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

  const handleRunStarted = useCallback((execId: number) => {
    setRunExecId(execId);
  }, []);

  const handleBackToDesigner = useCallback(() => {
    setRunExecId(null);
  }, []);

  return (
    <div className="job-runner-page">
      <DefinitionListSidebar
        selectedId={selectedDefId}
        onSelectDefinition={handleSelect}
        onNewDefinition={handleNew}
        refreshKey={refreshKey}
        isActive={isActive}
      />
      <div className="job-runner-main">
        {runExecId !== null ? (
          <ExecutionViewPage
            key={runExecId}
            rootExecId={runExecId}
            onBack={handleBackToDesigner}
          />
        ) : (
          <DefinitionForm
            key={selectedDefId ?? "new"}
            defId={selectedDefId}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onCancel={handleNew}
            onRunStarted={handleRunStarted}
          />
        )}
      </div>
    </div>
  );
}
