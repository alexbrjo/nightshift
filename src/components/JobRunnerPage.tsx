import { useState, useCallback } from "react";
import InferenceJobForm from "./InferenceJobForm";
import JobListSidebar from "./JobListSidebar";
import JobViewPage from "./JobViewPage";
import CollectionViewer from "./CollectionViewer";

interface JobRunnerPageProps {
  onBack?: () => void;
}

export default function JobRunnerPage({ onBack: _onBack }: JobRunnerPageProps) {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [viewingCollectionId, setViewingCollectionId] = useState<number | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);

  const handleJobCreated = useCallback((jobId: number) => {
    setSelectedJobId(jobId);
    setListRefreshKey((k) => k + 1);
  }, []);

  const handleNewJob = useCallback(() => {
    setSelectedJobId(null);
    setViewingCollectionId(null);
  }, []);

  if (viewingCollectionId) {
    return (
      <CollectionViewer
        collectionId={viewingCollectionId}
        onBack={() => setViewingCollectionId(null)}
      />
    );
  }

  return (
    <div className="job-runner-page">
      <JobListSidebar
        selectedId={selectedJobId}
        onSelectJob={setSelectedJobId}
        onNewJob={handleNewJob}
        refreshKey={listRefreshKey}
      />
      <div className="job-runner-main">
        {selectedJobId ? (
          <JobViewPage
            jobId={selectedJobId}
            onViewCollection={setViewingCollectionId}
          />
        ) : (
          <InferenceJobForm
            isOpen={true}
            onClose={handleNewJob}
            onSuccess={handleJobCreated}
          />
        )}
      </div>
    </div>
  );
}
