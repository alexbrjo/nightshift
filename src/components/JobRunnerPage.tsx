import { useState, useCallback } from "react";
import InferenceJobForm, { type JobConfig } from "./InferenceJobForm";
import JobListSidebar from "./JobListSidebar";
import JobViewPage from "./JobViewPage";

interface JobRunnerPageProps {
  onBack?: () => void;
}

export default function JobRunnerPage({ onBack }: JobRunnerPageProps) {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);

  const handleJobCreated = useCallback((jobId: number) => {
    // Optionally auto-select the newly created job
    setSelectedJobId(jobId);
  }, []);

  const handleSelectJob = useCallback((jobId: number) => {
    setSelectedJobId(jobId);
  }, []);

  const handleBackToJobList = useCallback(() => {
    setSelectedJobId(null);
  }, []);

  // If viewing a specific job, show the job details page
  if (selectedJobId) {
    return <JobViewPage jobId={selectedJobId} onBack={handleBackToJobList} />;
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
