use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tracing::info;

use crate::execution::sampling::SamplingStrategy;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobStatus {
    Pending,
    Queued,
    Running,
    Completed,
    Failed(String),
    Cancelled,
}

impl Default for JobStatus {
    fn default() -> Self {
        JobStatus::Pending
    }
}

/// Progress update for a single sample
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct SampleProgress {
    pub sample_index: usize,
    pub total_samples: usize,
    pub status: SampleStatus,
    pub error_message: Option<String>,
    pub retry_count: u32,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum SampleStatus {
    Queued,
    Processing,
    Completed,
    Failed,
    Retrying,
}

/// Overall job progress
#[derive(Debug, Clone, Serialize)]
pub struct JobProgress {
    pub job_id: i64,
    pub job_name: String,
    pub status: JobStatus,
    pub current_sample: usize,
    pub total_samples: usize,
    pub completed_samples: usize,
    pub failed_samples: usize,
    pub overall_progress: f64, // 0.0 to 1.0
}

/// Event sent during job execution
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum JobEvent {
    Started {
        job_id: i64,
        job_name: String,
        total_samples: usize,
    },
    SampleStarted {
        sample_index: usize,
        total_samples: usize,
    },
    SampleCompleted {
        sample_index: usize,
        total_samples: usize,
        output: serde_json::Value,
    },
    SampleFailed {
        sample_index: usize,
        total_samples: usize,
        error: String,
        retry_count: u32,
    },
    ProgressUpdate(JobProgress),
    Completed {
        job_id: i64,
        success_count: usize,
        failure_count: usize,
    },
    #[allow(dead_code)]
    Failed {
        job_id: i64,
        error: String,
    },
    Cancelled {
        job_id: i64,
        completed_samples: usize,
    },
}

/// Configuration for a running job
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub job_id: i64,
    pub job_type: String,
    pub name: String,
    pub prompt_file: String,
    pub data_source: String,
    pub provider: String,
    pub model: String,
    pub server_url: String,
    pub output_mode: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i32>,
    pub thinking_budget: Option<i32>,
    pub samples: i32,
    pub strategy: SamplingStrategy,
    pub json_schema_file: Option<String>,
    pub transform_script_file: Option<String>,
    pub transform_error_mode: String,
    pub transform_output_mode: String,
}

impl WorkerConfig {
    /// Create from database job record
    pub fn from_job(job: crate::database::InferenceJob) -> Self {
        let strategy = job.strategy.parse().unwrap_or(SamplingStrategy::Single);

        WorkerConfig {
            job_id: job.id,
            job_type: job.job_type,
            name: job.name,
            prompt_file: job.prompt_file,
            data_source: job.data_source,
            provider: job.provider,
            model: job.model,
            server_url: job.server_url,
            output_mode: job.output_mode,
            temperature: job.temperature.map(|t| t as f64), // Convert f32 to f64
            max_tokens: job.max_tokens,
            thinking_budget: job.thinking_budget,
            samples: job.samples,
            strategy,
            json_schema_file: job.json_schema_file,
            transform_script_file: job.transform_script_file,
            transform_error_mode: job.transform_error_mode.unwrap_or_else(|| "stop".to_string()),
            transform_output_mode: job
                .transform_output_mode
                .unwrap_or_else(|| "one_to_one".to_string()),
        }
    }
}

/// Cancellation token for graceful shutdown
#[derive(Debug, Clone)]
pub struct CancellationToken {
    inner: Arc<Mutex<bool>>,
}

impl CancellationToken {
    pub fn new() -> Self {
        CancellationToken { inner: Arc::new(Mutex::new(false)) }
    }

    pub async fn cancel(&self) {
        let mut cancelled = self.inner.lock().await;
        *cancelled = true;
    }

    pub async fn is_cancelled(&self) -> bool {
        *self.inner.lock().await
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

/// Job queue with state management
pub struct JobQueue {
    jobs: RwLock<HashMap<i64, JobStatus>>,
    cancellations: RwLock<HashMap<i64, CancellationToken>>,
}

impl JobQueue {
    pub fn new() -> Self {
        JobQueue { jobs: RwLock::new(HashMap::new()), cancellations: RwLock::new(HashMap::new()) }
    }

    pub async fn enqueue(&self, job_id: i64) {
        let mut jobs = self.jobs.write().await;
        jobs.insert(job_id, JobStatus::Queued);
        info!("Job {} enqueued", job_id);
    }

    pub async fn start(&self, job_id: i64) {
        let mut jobs = self.jobs.write().await;
        jobs.insert(job_id, JobStatus::Running);

        // Create cancellation token for this job
        let mut cancellations = self.cancellations.write().await;
        cancellations.insert(job_id, CancellationToken::new());

        info!("Job {} started", job_id);
    }

    pub async fn complete(&self, job_id: i64) {
        let mut jobs = self.jobs.write().await;
        jobs.insert(job_id, JobStatus::Completed);

        // Clean up cancellation token
        let mut cancellations = self.cancellations.write().await;
        cancellations.remove(&job_id);

        info!("Job {} completed", job_id);
    }

    pub async fn fail(&self, job_id: i64, error: String) {
        let mut jobs = self.jobs.write().await;
        jobs.insert(job_id, JobStatus::Failed(error));

        // Clean up cancellation token
        let mut cancellations = self.cancellations.write().await;
        cancellations.remove(&job_id);

        info!("Job {} failed", job_id);
    }

    pub async fn cancel(&self, job_id: i64) -> bool {
        let jobs = self.jobs.read().await;
        if let Some(status) = jobs.get(&job_id) {
            if matches!(status, JobStatus::Running | JobStatus::Queued) {
                drop(jobs);

                // Signal cancellation. Clone the token out so we can release the
                // map lock before awaiting cancel().
                let token = {
                    let cancellations = self.cancellations.read().await;
                    cancellations.get(&job_id).cloned()
                };
                if let Some(token) = token {
                    token.cancel().await;
                }

                // Update status
                let mut jobs = self.jobs.write().await;
                jobs.insert(job_id, JobStatus::Cancelled);

                info!("Job {} cancelled", job_id);
                return true;
            }
        }
        false
    }

    pub async fn get_status(&self, job_id: i64) -> Option<JobStatus> {
        let jobs = self.jobs.read().await;
        jobs.get(&job_id).cloned()
    }

    pub async fn is_running(&self, job_id: i64) -> bool {
        let jobs = self.jobs.read().await;
        matches!(jobs.get(&job_id), Some(JobStatus::Running))
    }

    pub async fn get_cancellation_token(&self, job_id: i64) -> Option<CancellationToken> {
        let cancellations = self.cancellations.read().await;
        cancellations.get(&job_id).cloned()
    }
}

impl Default for JobQueue {
    fn default() -> Self {
        Self::new()
    }
}
