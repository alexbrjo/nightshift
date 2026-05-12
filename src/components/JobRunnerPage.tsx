import { useState, useCallback } from "react";
import InferenceJobForm from "./InferenceJobForm";
import JobListSidebar from "./JobListSidebar";
import JobViewPage from "./JobViewPage";
import type { Collection } from "../database";

interface JobRunnerPageProps {
  isActive?: boolean;
  /**
   * Called when the user clicks "View Collection" on a job. The App-level
   * handler switches to the Collections section and selects the given id, so
   * the user lands in the Collections sidebar with the collection open.
   */
  onViewCollection?: (collection: Collection) => void;
}

export default function JobRunnerPage({ isActive = true, onViewCollection }: JobRunnerPageProps) {
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
          <JobViewPage
            jobId={selectedJobId}
            onViewCollection={onViewCollection}
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
