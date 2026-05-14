import { useState, useCallback } from "react";
import InferenceJobForm from "./InferenceJobForm";
import JobListSidebar from "./JobListSidebar";
import JobViewPage from "./JobViewPage";

interface JobRunnerPageProps {
  isActive?: boolean;
}

export default function JobRunnerPage({ isActive = true }: JobRunnerPageProps) {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);

  const handleJobCreated = useCallback((jobId: number) => {
    setSelectedJobId(jobId);
    setListRefreshKey((k) => k + 1);
  }, []);

  const handleNewJob = useCallback(() => {
    setSelectedJobId(null);
  }, []);

  return (
    <div className="job-runner-page">
      <JobListSidebar
        selectedId={selectedJobId}
        onSelectJob={setSelectedJobId}
        onNewJob={handleNewJob}
        refreshKey={listRefreshKey}
        isActive={isActive}
      />
      <div className="job-runner-main">
        {selectedJobId ? (
          <JobViewPage jobId={selectedJobId} />
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
