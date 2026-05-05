import { useCallback, useState } from "react";

import DefinitionForm from "./DefinitionForm";
import DefinitionTreeSidebar from "./DefinitionTreeSidebar";

interface DefinitionsPageProps {
  isActive?: boolean;
}

/**
 * Definitions section: tree sidebar on the left, per-node form on the right.
 * Job execution starts and lives on the Job Executions page; this page is
 * authoring-only.
 */
export default function DefinitionsPage({ isActive = true }: DefinitionsPageProps) {
  const [selectedDefId, setSelectedDefId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSaved = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleDeleted = useCallback(() => {
    setSelectedDefId(null);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="job-runner-page">
      <DefinitionTreeSidebar
        selectedId={selectedDefId}
        onSelectDefinition={setSelectedDefId}
        refreshKey={refreshKey}
        isActive={isActive}
        title="Definitions"
      />
      <div className="job-runner-main">
        {selectedDefId === null ? (
          <div className="editor-placeholder">
            Select a definition or create a new one to get started.
          </div>
        ) : (
          <DefinitionForm
            key={selectedDefId}
            defId={selectedDefId}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
          />
        )}
      </div>
    </div>
  );
}
