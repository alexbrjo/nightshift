import { useState, useCallback } from "react";
import InferenceJobForm from "./InferenceJobForm";
import JobListSidebar from "./JobListSidebar";
import JobViewPage from "./JobViewPage";
import CollectionViewer from "./CollectionViewer";

interface JobRunnerPageProps {
  onBack?: () => void;
}

export default function JobRunnerPage({ onBack }: JobRunnerPageProps) {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [viewingCollectionId, setViewingCollectionId] = useState<number | null>(null);

  const handleJobCreated = useCallback((jobId: number) => {
    // Optionally auto-select the newly created job
    setSelectedJobId(jobId);
  }, []);

  const handleSelectJob = useCallback((jobId: number) => {
    setSelectedJobId(jobId);
  }, []);

  const handleBackToJobList = useCallback(() => {
    setSelectedJobId(null);
    setViewingCollectionId(null);
  }, []);

  const handleViewCollection = useCallback((collectionId: number) => {
    setViewingCollectionId(collectionId);
  }, []);

  const handleBackFromCollection = useCallback(() => {
    setViewingCollectionId(null);
  }, []);

  // If viewing a collection, show the collection viewer
  if (viewingCollectionId) {
    return <CollectionViewer collectionId={viewingCollectionId} onBack={handleBackFromCollection} />;
  }

  // If viewing a specific job, show the job details page
  if (selectedJobId) {
    return <JobViewPage jobId={selectedJobId} onBack={handleBackToJobList} onViewCollection={handleViewCollection} />;
  }

  return (
    <div className="job-runner-page">
      {/* Header */}
      <div className="page-header job-runner-header">
        {onBack && (
          <button className="btn-secondary" onClick={onBack}>
            ← Back
          </button>
        )}
        <h1>Inference Jobs</h1>
      </div>

      {/* Main Content Area - Form on top, List below */}
      <div className="job-runner-content">
        {/* Create New Job Section */}
        <section className="create-job-section">
          <InferenceJobForm
            isOpen={true}
            onClose={() => {}} // No-op since form is always visible
            onSuccess={handleJobCreated}
          />
        </section>

        {/* Divider */}
        <div className="content-divider"></div>

        {/* Job List Section */}
        <section className="job-list-section">
          <h2>Your Jobs</h2>
          <JobListSidebar
            onSelectJob={handleSelectJob}
            onNewJob={() => {}} // No-op since form is always visible
          />
        </section>
      </div>
    </div>
  );
}
