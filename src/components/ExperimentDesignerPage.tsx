import { useState, useCallback } from "react";

import DefinitionForm from "./DefinitionForm";
import DefinitionListSidebar from "./DefinitionListSidebar";

interface ExperimentDesignerPageProps {
  isActive?: boolean;
}

export default function ExperimentDesignerPage({
  isActive = true,
}: ExperimentDesignerPageProps) {
  const [selectedDefId, setSelectedDefId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSaved = useCallback((defId: number) => {
    setSelectedDefId(defId);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleNew = useCallback(() => {
    setSelectedDefId(null);
  }, []);

  const handleDeleted = useCallback(() => {
    setSelectedDefId(null);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="job-runner-page">
      <DefinitionListSidebar
        selectedId={selectedDefId}
        onSelectDefinition={setSelectedDefId}
        onNewDefinition={handleNew}
        refreshKey={refreshKey}
        isActive={isActive}
      />
      <div className="job-runner-main">
        {/* The `key` re-mounts the form when selection changes — preserves the
            legacy "switch from A to B without form leakage" pattern. */}
        <DefinitionForm
          key={selectedDefId ?? "new"}
          defId={selectedDefId}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onCancel={handleNew}
        />
      </div>
    </div>
  );
}
