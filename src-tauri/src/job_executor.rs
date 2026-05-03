use minijinja::{Environment, UndefinedBehavior, Value as MjValue};
use rand::prelude::SliceRandom;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{sleep, Duration};
use tracing::{debug, error, info, instrument, warn};
use url::Url;

use crate::database::DatabaseState;
use crate::transform_runner;

/// Job execution status
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

/// Sampling strategy for job execution. The number of samples is taken from
/// `WorkerConfig::samples` rather than carried inline so the user's chosen
/// `samples` value flows through every strategy uniformly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SamplingStrategy {
    Single,
    Random,
    Exhaustive,
}

impl std::str::FromStr for SamplingStrategy {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "single" => Ok(SamplingStrategy::Single),
            "random" | "random_samples" => Ok(SamplingStrategy::Random),
            "exhaustive" | "all" => Ok(SamplingStrategy::Exhaustive),
            _ => Err(format!("Unknown sampling strategy: {}", s)),
        }
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

/// LLM API request structure (OpenAI-compatible Chat Completions).
#[derive(Debug, Serialize)]
struct LlmRequest {
    model: String,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize)]
struct Message {
    role: String,
    content: String,
}

/// Map the form's thinking-budget integer to OpenAI's `reasoning_effort` enum.
/// The form encodes Off/Low/Medium/High as 500/1000/1500/2000 token budgets,
/// but OpenAI's o-series API takes a categorical value. None or 0 disables it.
fn thinking_budget_to_effort(budget: Option<i32>) -> Option<String> {
    let b = budget?;
    if b <= 0 {
        return None;
    }
    Some(if b <= 750 {
        "low".to_string()
    } else if b <= 1250 {
        "medium".to_string()
    } else {
        "high".to_string()
    })
}

/// LLM API response structure
#[derive(Debug, Deserialize)]
struct LlmResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    content: Option<String>,
    /// Some thinking-capable models (Qwen3, DeepSeek-R1, etc.) emit the
    /// answer here and leave `content` empty even when reasoning is meant
    /// to be off. Fall back to this when `content` is empty.
    #[serde(default)]
    reasoning_content: Option<String>,
}

impl ResponseMessage {
    fn extract_content(&self) -> &str {
        let primary = self.content.as_deref().unwrap_or("");
        if !primary.trim().is_empty() {
            return primary;
        }
        self.reasoning_content.as_deref().unwrap_or("")
    }
}

/// Job executor with worker logic
#[derive(Clone)]
pub struct JobExecutor {
    pub db: DatabaseState,
    pub queue: Arc<JobQueue>,
    pub client: Client,
}

impl JobExecutor {
    pub fn new(db: State<'_, DatabaseState>) -> Result<Self, String> {
        let db_state = (*db).clone();
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        Ok(JobExecutor { db: db_state, queue: Arc::new(JobQueue::new()), client })
    }

    /// Start an inference job asynchronously.
    /// Allows restart from terminal statuses (completed, failed, cancelled) and the
    /// initial pending/queued statuses; only rejects if already running.
    #[instrument(skip(self), fields(job_id))]
    pub async fn start_job(&self, job_id: i64) -> Result<(), String> {
        if self.queue.is_running(job_id).await {
            return Err("Job is already running".to_string());
        }

        let job = crate::database::get_inference_job_by_id(&self.db.pool(), job_id)
            .await?
            .ok_or("Job not found")?;

        match job.status.as_str() {
            "pending" | "queued" | "completed" | "failed" | "cancelled" => {}
            other => return Err(format!("Job cannot be started from status: {}", other)),
        }

        // Flip DB status to "running". Do not rewrite other columns.
        crate::database::update_job_status(&self.db.pool(), job_id, "running").await?;
        crate::database::clear_job_failures(&self.db.pool(), job_id).await?;

        // Enqueue and start in-memory state.
        self.queue.enqueue(job_id).await;
        self.queue.start(job_id).await;

        info!("Job {} started successfully", job_id);
        Ok(())
    }

    /// Cancel a running job. Updates only the status column; preserves all
    /// configuration fields untouched.
    #[instrument(skip(self), fields(job_id))]
    pub async fn cancel_job(&self, job_id: i64) -> Result<bool, String> {
        let cancelled = self.queue.cancel(job_id).await;

        if cancelled {
            if let Err(e) =
                crate::database::update_job_status(&self.db.pool(), job_id, "cancelled").await
            {
                warn!("Failed to update cancelled job status in DB: {}", e);
            }
        }

        Ok(cancelled)
    }

    /// Execute the job with all samples
    #[instrument(skip(self, tx), fields(job_id))]
    pub async fn execute_job(
        &self,
        config: WorkerConfig,
        tx: mpsc::Sender<JobEvent>,
    ) -> Result<(), String> {
        if config.job_type == "transform" {
            return self.execute_transform_job(config, tx).await;
        }

        let cancellation = self
            .queue
            .get_cancellation_token(config.job_id)
            .await
            .ok_or("Cancellation token not found")?;

        info!("Starting job execution for {} with {} samples", config.name, config.samples);

        // Load data from source
        let samples = self.load_samples(&config).await?;
        info!("Loaded {} samples from {}", samples.len(), config.data_source);

        if samples.is_empty() {
            warn!("No samples loaded for job {}", config.job_id);
            let _ = tx
                .send(JobEvent::Completed {
                    job_id: config.job_id,
                    success_count: 0,
                    failure_count: 0,
                })
                .await;
            self.queue.complete(config.job_id).await;
            return Ok(());
        }

        let total_samples = samples.len();
        let mut completed_count = 0;
        let mut failed_count = 0;
        let mut last_error: Option<String> = None;

        // Create or get collection for this job
        let collection_id = self.ensure_collection(&config).await?;
        info!("Using collection {} for job {}", collection_id, config.job_id);

        // Send started event
        if tx
            .send(JobEvent::Started {
                job_id: config.job_id,
                job_name: config.name.clone(),
                total_samples,
            })
            .await
            .is_err()
        {
            warn!("Failed to send started event");
        }

        // Process each sample
        for (index, sample) in samples.into_iter().enumerate() {
            // Check cancellation
            if cancellation.is_cancelled().await {
                info!("Job {} cancelled at sample {}/{}", config.job_id, index, total_samples);

                let _ = tx
                    .send(JobEvent::Cancelled {
                        job_id: config.job_id,
                        completed_samples: completed_count,
                    })
                    .await;

                self.queue.complete(config.job_id).await;
                return Ok(());
            }

            // Send sample started event
            if tx
                .send(JobEvent::SampleStarted { sample_index: index, total_samples })
                .await
                .is_err()
            {
                warn!("Failed to send sample started event");
            }

            // Process sample with retry logic
            match self.process_sample(&config, index, &sample, &cancellation, &tx).await {
                Ok(output) => {
                    completed_count += 1;
                    info!(
                        "Sample {} succeeded for job {} (progress: {}/{})",
                        index, config.job_id, completed_count, total_samples
                    );

                    // Save output to collection
                    if let Err(e) = self.save_to_collection(collection_id, &output).await {
                        warn!("Failed to save output to collection: {}", e);
                    }

                    if tx
                        .send(JobEvent::SampleCompleted {
                            sample_index: index,
                            total_samples,
                            output: output.clone(),
                        })
                        .await
                        .is_err()
                    {
                        warn!("Failed to send sample completed event");
                    }
                }
                Err(e) => {
                    failed_count += 1;
                    last_error = Some(e.clone());
                    if let Err(record_err) =
                        crate::database::add_job_failure(&self.db.pool(), config.job_id, index, &e)
                            .await
                    {
                        warn!("Failed to record job failure: {}", record_err);
                    }
                    error!(
                        "Sample {} failed for job {}: {} (progress: {}/{})",
                        index, config.job_id, e, completed_count, total_samples
                    );

                    if tx
                        .send(JobEvent::SampleFailed {
                            sample_index: index,
                            total_samples,
                            error: e.clone(),
                            retry_count: 0,
                        })
                        .await
                        .is_err()
                    {
                        warn!("Failed to send sample failed event");
                    }
                }
            }

            // Send progress update
            let progress = JobProgress {
                job_id: config.job_id,
                job_name: config.name.clone(),
                status: JobStatus::Running,
                current_sample: index + 1,
                total_samples,
                completed_samples: completed_count,
                failed_samples: failed_count,
                overall_progress: (index + 1) as f64 / total_samples as f64,
            };

            if tx.send(JobEvent::ProgressUpdate(progress)).await.is_err() {
                warn!("Failed to send progress update");
            }
        }

        // Send completion event. If every sample failed, surface as Failed so
        // the job's DB status reflects the failure and the user sees the error.
        info!("Sending completion event for job {}", config.job_id);
        if completed_count == 0 && failed_count > 0 {
            let _ = tx
                .send(JobEvent::Failed {
                    job_id: config.job_id,
                    error: last_error
                        .unwrap_or_else(|| format!("All {} samples failed", failed_count)),
                })
                .await;
        } else {
            let _ = tx
                .send(JobEvent::Completed {
                    job_id: config.job_id,
                    success_count: completed_count,
                    failure_count: failed_count,
                })
                .await;
        }

        info!("Marking job {} as complete in queue", config.job_id);
        self.queue.complete(config.job_id).await;

        info!(
            "Job {} completed: {} successful, {} failed",
            config.job_id, completed_count, failed_count
        );

        Ok(())
    }

    async fn execute_transform_job(
        &self,
        config: WorkerConfig,
        tx: mpsc::Sender<JobEvent>,
    ) -> Result<(), String> {
        let cancellation = self
            .queue
            .get_cancellation_token(config.job_id)
            .await
            .ok_or("Cancellation token not found")?;
        transform_runner::check_transform_runtime().await?;

        let script_file = config
            .transform_script_file
            .as_deref()
            .ok_or("Transform job is missing a script file")?;
        let script_path = self.resolve_within_project(script_file)?;
        let script = tokio::fs::read_to_string(&script_path)
            .await
            .map_err(|e| format!("Failed to read transform script {}: {}", script_file, e))?;

        let samples = self.load_samples(&config).await?;
        let total_samples = samples.len();
        let collection_id = self.ensure_collection(&config).await?;

        let _ = tx
            .send(JobEvent::Started {
                job_id: config.job_id,
                job_name: config.name.clone(),
                total_samples,
            })
            .await;

        let mut completed_count = 0;
        let mut failed_count = 0;
        let mut last_error: Option<String> = None;

        for (index, sample) in samples.into_iter().enumerate() {
            if cancellation.is_cancelled().await {
                let _ = tx
                    .send(JobEvent::Cancelled {
                        job_id: config.job_id,
                        completed_samples: completed_count,
                    })
                    .await;
                self.queue.complete(config.job_id).await;
                return Ok(());
            }

            let _ = tx.send(JobEvent::SampleStarted { sample_index: index, total_samples }).await;

            match transform_runner::run_transform_script(&script, &sample).await {
                Ok(Some(output)) => {
                    if let Err(e) =
                        self.save_transform_output(collection_id, &config, &output).await
                    {
                        self.delete_collection(collection_id).await?;
                        return Err(e);
                    }
                    completed_count += 1;
                    let _ = tx
                        .send(JobEvent::SampleCompleted {
                            sample_index: index,
                            total_samples,
                            output,
                        })
                        .await;
                }
                Ok(None) => {
                    completed_count += 1;
                    let _ = tx
                        .send(JobEvent::SampleCompleted {
                            sample_index: index,
                            total_samples,
                            output: serde_json::Value::Null,
                        })
                        .await;
                }
                Err(e) => {
                    failed_count += 1;
                    last_error = Some(e.clone());
                    if let Err(record_err) =
                        crate::database::add_job_failure(&self.db.pool(), config.job_id, index, &e)
                            .await
                    {
                        warn!("Failed to record job failure: {}", record_err);
                    }
                    let _ = tx
                        .send(JobEvent::SampleFailed {
                            sample_index: index,
                            total_samples,
                            error: e.clone(),
                            retry_count: 0,
                        })
                        .await;
                    if config.transform_error_mode != "skip" {
                        self.delete_collection(collection_id).await?;
                        let _ = tx.send(JobEvent::Failed { job_id: config.job_id, error: e }).await;
                        self.queue.complete(config.job_id).await;
                        return Ok(());
                    }
                }
            }

            let progress = JobProgress {
                job_id: config.job_id,
                job_name: config.name.clone(),
                status: JobStatus::Running,
                current_sample: index + 1,
                total_samples,
                completed_samples: completed_count,
                failed_samples: failed_count,
                overall_progress: if total_samples == 0 {
                    1.0
                } else {
                    (index + 1) as f64 / total_samples as f64
                },
            };
            let _ = tx.send(JobEvent::ProgressUpdate(progress)).await;
        }

        if completed_count == 0 && failed_count > 0 {
            let _ = tx
                .send(JobEvent::Failed {
                    job_id: config.job_id,
                    error: last_error.unwrap_or_else(|| "All transform items failed".to_string()),
                })
                .await;
        } else {
            let _ = tx
                .send(JobEvent::Completed {
                    job_id: config.job_id,
                    success_count: completed_count,
                    failure_count: failed_count,
                })
                .await;
        }

        self.queue.complete(config.job_id).await;
        Ok(())
    }

    /// Ensure collection exists for job. The UNIQUE(job_id) constraint on the
    /// collections table makes this race-safe even under concurrent calls:
    /// `INSERT OR IGNORE` either creates the row or no-ops if another caller
    /// already did, then the SELECT returns the unique row.
    async fn ensure_collection(&self, config: &WorkerConfig) -> Result<i64, String> {
        sqlx::query(r#"INSERT OR IGNORE INTO collections (job_id, name) VALUES (?, ?)"#)
            .bind(config.job_id)
            .bind(format!("{} outputs", config.name))
            .execute(&self.db.pool())
            .await
            .map_err(|e| format!("Failed to create collection: {}", e))?;

        let result: (i64,) = sqlx::query_as(r#"SELECT id FROM collections WHERE job_id = ?"#)
            .bind(config.job_id)
            .fetch_one(&self.db.pool())
            .await
            .map_err(|e| format!("Failed to get collection ID: {}", e))?;

        Ok(result.0)
    }

    /// Save output to collection
    async fn save_to_collection(
        &self,
        collection_id: i64,
        data: &serde_json::Value,
    ) -> Result<(), String> {
        sqlx::query(r#"INSERT INTO collection_items (collection_id, data) VALUES (?, ?)"#)
            .bind(collection_id)
            .bind(data)
            .execute(&self.db.pool())
            .await
            .map_err(|e| format!("Failed to save collection item: {}", e))?;

        Ok(())
    }

    async fn save_transform_output(
        &self,
        collection_id: i64,
        config: &WorkerConfig,
        data: &serde_json::Value,
    ) -> Result<(), String> {
        if config.transform_output_mode == "unwrap_arrays" {
            if let serde_json::Value::Array(items) = data {
                for item in items {
                    self.save_to_collection(collection_id, item).await?;
                }
                return Ok(());
            }
        }

        self.save_to_collection(collection_id, data).await
    }

    async fn delete_collection(&self, collection_id: i64) -> Result<(), String> {
        sqlx::query(r#"DELETE FROM collections WHERE id = ?"#)
            .bind(collection_id)
            .execute(&self.db.pool())
            .await
            .map_err(|e| format!("Failed to delete partial collection: {}", e))?;

        Ok(())
    }

    /// Resolve a user-supplied relative path against the project root, rejecting
    /// absolute paths, `..` components, and any path that — after symlink
    /// resolution — escapes the project root.
    fn resolve_within_project(&self, user_path: &str) -> Result<std::path::PathBuf, String> {
        use std::path::{Component, Path};

        let path = Path::new(user_path);
        if path.is_absolute() {
            return Err(format!("Absolute paths are not allowed: {}", user_path));
        }
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(format!("Path may not contain '..': {}", user_path));
        }

        let root = self.db.get_project_root();
        let root_canonical = std::fs::canonicalize(&root)
            .map_err(|e| format!("Failed to resolve project root {}: {}", root.display(), e))?;
        let full = root_canonical.join(path);
        let full_canonical = std::fs::canonicalize(&full)
            .map_err(|e| format!("Failed to resolve path {}: {}", full.display(), e))?;

        if !full_canonical.starts_with(&root_canonical) {
            return Err(format!("Path escapes project root: {}", user_path));
        }
        Ok(full_canonical)
    }

    /// Load samples from a data source — either a project-relative file path
    /// or a `collection:<id>` reference to an existing collection.
    async fn load_samples(&self, config: &WorkerConfig) -> Result<Vec<serde_json::Value>, String> {
        debug!(
            "Loading samples from data source: {} with strategy: {:?}",
            config.data_source, config.strategy
        );

        let samples = if let Some(rest) = config.data_source.strip_prefix("collection:") {
            let id: i64 = rest.parse().map_err(|_| format!("Invalid collection id: {}", rest))?;
            self.load_collection_samples(id).await?
        } else {
            self.load_file_samples(&config.data_source).await?
        };

        debug!("Loaded {} samples from {}", samples.len(), config.data_source);

        if let Some(first) = samples.first() {
            debug!(
                "First sample keys: {:?}",
                first.as_object().map(|o| o.keys().collect::<Vec<_>>())
            );
            debug!("First sample content: {:?}", first);
        } else {
            warn!("No samples loaded from data source!");
        }

        Ok(Self::apply_strategy(samples, &config.strategy, config.samples))
    }

    async fn load_file_samples(&self, data_source: &str) -> Result<Vec<serde_json::Value>, String> {
        let full_path = self.resolve_within_project(data_source)?;
        debug!("Full data source path: {}", full_path.display());

        let content = tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|e| format!("Failed to read data source {}: {}", data_source, e))?;

        let mut samples: Vec<serde_json::Value> = Vec::new();

        if content.trim().starts_with('[') {
            let parsed: Vec<serde_json::Value> = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse JSON array from {}: {}", data_source, e))?;
            samples = parsed;
        } else {
            for (line_num, line) in content.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }

                match serde_json::from_str(trimmed) {
                    Ok(obj) => samples.push(obj),
                    Err(e) => {
                        warn!("Failed to parse line {} in {}: {}", line_num + 1, data_source, e);
                    }
                }
            }
        }

        Ok(samples)
    }

    async fn load_collection_samples(
        &self,
        collection_id: i64,
    ) -> Result<Vec<serde_json::Value>, String> {
        // Re-check eligibility at execution time. The picker only lists
        // collections whose owning job is `completed`, but a job's `data_source`
        // can also be set via YAML import, persisted before the source job
        // finishes, or read after the source was deleted/cancelled. Mirror the
        // picker's filter so jobs never run against partial / stale data.
        let source_status = sqlx::query_scalar::<_, Option<String>>(
            r#"
            SELECT j.status
            FROM collections c
            JOIN inference_jobs j ON j.id = c.job_id
            WHERE c.id = ?
            "#,
        )
        .bind(collection_id)
        .fetch_optional(&self.db.pool())
        .await
        .map_err(|e| format!("Failed to check collection eligibility: {}", e))?
        .flatten();

        match source_status.as_deref() {
            None => {
                return Err(format!("Collection no longer exists (id={})", collection_id));
            }
            Some("completed") => {}
            Some(other) => {
                return Err(format!(
                    "Collection {} is not usable as a data source: source job is {}",
                    collection_id, other
                ));
            }
        }

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT data FROM collection_items WHERE collection_id = ? ORDER BY created_at ASC, id ASC",
        )
        .bind(collection_id)
        .fetch_all(&self.db.pool())
        .await
        .map_err(|e| format!("Failed to load collection items: {}", e))?;

        Ok(rows.into_iter().map(parse_content_field).collect())
    }

    fn apply_strategy(
        samples: Vec<serde_json::Value>,
        strategy: &SamplingStrategy,
        limit: i32,
    ) -> Vec<serde_json::Value> {
        match strategy {
            SamplingStrategy::Single => {
                samples.into_iter().next().map(|s| vec![s]).unwrap_or_default()
            }
            SamplingStrategy::Random => {
                let count = (limit.max(0) as usize).min(samples.len());
                if count == 0 || samples.is_empty() {
                    return Vec::new();
                }
                let mut rng = rand::rng();
                let mut indices: Vec<usize> = (0..samples.len()).collect();
                indices.shuffle(&mut rng);
                indices.into_iter().take(count).map(|i| samples[i].clone()).collect()
            }
            SamplingStrategy::Exhaustive => {
                // Iterate every row, repeated `limit` times each. `limit` is
                // "samples per row" — useful for sampling LLM variance per
                // input. A limit < 1 is treated as 1 to preserve the
                // "run them all once" baseline.
                let reps = if limit > 1 { limit as usize } else { 1 };
                let mut out = Vec::with_capacity(samples.len() * reps);
                for s in samples {
                    for _ in 0..reps {
                        out.push(s.clone());
                    }
                }
                out
            }
        }
    }

    /// Process a single sample with retry logic
    #[instrument(skip(self, config, cancellation, tx), fields(sample_index))]
    async fn process_sample(
        &self,
        config: &WorkerConfig,
        sample_index: usize,
        sample: &serde_json::Value,
        cancellation: &CancellationToken,
        tx: &mpsc::Sender<JobEvent>,
    ) -> Result<serde_json::Value, String> {
        let max_retries = 3;
        let base_delay = Duration::from_secs(1);

        info!(
            "Processing sample {}/{} for job {}",
            sample_index + 1,
            config.samples,
            config.job_id
        );

        for attempt in 0..=max_retries {
            // Check cancellation before each attempt
            if cancellation.is_cancelled().await {
                return Err("Cancelled".to_string());
            }

            debug!(
                "Attempting LLM call for sample {} (attempt {}/{})",
                sample_index + 1,
                attempt + 1,
                max_retries + 1
            );
            match self.attempt_llm_call(config, sample_index, sample).await {
                Ok(output) => return Ok(output),
                Err(e) => {
                    let is_rate_limit = e.contains("429") || e.contains("rate limit");

                    if attempt < max_retries && is_rate_limit {
                        let delay = base_delay * 2u32.pow(attempt as u32); // Exponential backoff

                        info!(
                            "Rate limited, retrying sample {} in {:?} (attempt {}/{})",
                            sample_index,
                            delay,
                            attempt + 1,
                            max_retries
                        );

                        if tx
                            .send(JobEvent::SampleFailed {
                                sample_index,
                                total_samples: 0, // Will be updated by caller
                                error: e.clone(),
                                retry_count: attempt + 1,
                            })
                            .await
                            .is_err()
                        {
                            warn!("Failed to send retry event");
                        }

                        sleep(delay).await;
                    } else {
                        return Err(e);
                    }
                }
            }
        }

        Err("Max retries exceeded".to_string())
    }

    /// Attempt a single LLM API call
    #[instrument(skip(self, config, sample))]
    async fn attempt_llm_call(
        &self,
        config: &WorkerConfig,
        sample_index: usize,
        sample: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // Provider routing. Local / OpenAI / Custom / Google all speak the
        // OpenAI Chat Completions wire format (Google via its OpenAI-compat
        // endpoint). Anthropic's /v1/messages API is structurally different
        // and not yet wired up.
        match config.provider.to_lowercase().as_str() {
            "local" | "openai" | "custom" | "google" | "" => {}
            "anthropic" => {
                return Err("Anthropic provider is not yet supported. Use Local/OpenAI/Custom \
                     pointed at an OpenAI-compatible endpoint."
                    .to_string());
            }
            other => {
                return Err(format!("Unknown provider: {}", other));
            }
        }

        // Validate server URL
        if Url::parse(&config.server_url).is_err() {
            return Err(format!("Invalid server URL: {}", config.server_url));
        }

        // Render prompt with sample data using MiniJinja
        let prompt_content = self.load_prompt_file(&config.prompt_file).await?;
        let rendered_prompt = self.render_prompt(&prompt_content, sample)?;

        let response_format = self.build_response_format(config).await?;
        let reasoning_effort = thinking_budget_to_effort(config.thinking_budget);

        let messages = vec![Message { role: "user".to_string(), content: rendered_prompt }];

        let request = LlmRequest {
            model: config.model.clone(),
            messages,
            temperature: config.temperature,
            max_tokens: config.max_tokens,
            response_format,
            reasoning_effort,
        };

        // Build the full endpoint URL (base URL + /v1/chat/completions)
        let endpoint_url = if config.server_url.ends_with("/v1") {
            format!("{}/chat/completions", config.server_url)
        } else if config.server_url.ends_with('/') {
            format!("{}v1/chat/completions", config.server_url)
        } else {
            format!("{}/v1/chat/completions", config.server_url)
        };

        debug!("Calling LLM API at {}", endpoint_url);

        // Call LLM API
        let response = self
            .client
            .post(&endpoint_url)
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        // Handle rate limiting
        if response.status().as_u16() == 429 {
            return Err("Rate limit exceeded (429)".to_string());
        }

        // Check status code first
        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!("API returned status {}: {}", status, body_text));
        }

        // Try to parse as JSON, but also capture raw text for debugging
        let response_text =
            response.text().await.map_err(|e| format!("Failed to read response body: {}", e))?;
        debug!("LLM response body: {}", &response_text);

        let llm_response: LlmResponse = serde_json::from_str(&response_text)
            .map_err(|e| format!("Failed to parse response JSON ({}): {}", e, response_text))?;

        // Extract content from response
        if let Some(choice) = llm_response.choices.first() {
            Ok(serde_json::json!({
                "content": choice.message.extract_content(),
                "model": config.model,
                "sample_index": sample_index as i64,
            }))
        } else {
            Err("No choices in response".to_string())
        }
    }

    /// Load prompt from file
    async fn load_prompt_file(&self, path: &str) -> Result<String, String> {
        let full_path = self.resolve_within_project(path)?;
        debug!("Loading prompt from: {} (resolved to: {})", path, full_path.display());

        let content = tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|e| format!("Failed to read prompt file {}: {}", path, e))?;

        debug!("Prompt file loaded successfully ({} bytes)", content.len());
        Ok(content)
    }

    /// Build the OpenAI-compatible `response_format` value for this job.
    /// `Unstructured` → no constraint, `Plain JSON` → JSON-object mode,
    /// `JSON Schema` → loads the user's schema file and embeds it strictly.
    async fn build_response_format(
        &self,
        config: &WorkerConfig,
    ) -> Result<Option<serde_json::Value>, String> {
        match config.output_mode.as_str() {
            "Plain JSON" => Ok(Some(serde_json::json!({ "type": "json_object" }))),
            "JSON Schema" => {
                let schema_file = config.json_schema_file.as_deref().ok_or_else(|| {
                    "Output mode is 'JSON Schema' but no schema file was selected".to_string()
                })?;
                let full_path = self.resolve_within_project(schema_file)?;
                let raw = tokio::fs::read_to_string(&full_path)
                    .await
                    .map_err(|e| format!("Failed to read schema file {}: {}", schema_file, e))?;
                let schema: serde_json::Value = serde_json::from_str(&raw)
                    .map_err(|e| format!("Schema file {} is not valid JSON: {}", schema_file, e))?;
                let name = std::path::Path::new(schema_file)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "schema".to_string());
                Ok(Some(serde_json::json!({
                    "type": "json_schema",
                    "json_schema": { "name": name, "strict": true, "schema": schema },
                })))
            }
            _ => Ok(None),
        }
    }

    fn render_prompt(&self, template: &str, sample: &serde_json::Value) -> Result<String, String> {
        render_prompt(template, sample)
    }
}

/// Collection items store the raw model output as `content: "<string>"`.
/// When that string is itself JSON (Plain JSON / JSON Schema output modes),
/// unwrap it so chained jobs receive the model's JSON object as the item.
fn parse_content_field(row: serde_json::Value) -> serde_json::Value {
    let Some(content) = row.get("content").and_then(|c| c.as_str()) else {
        return row;
    };
    match serde_json::from_str::<serde_json::Value>(content.trim()) {
        Ok(parsed) if parsed.is_object() || parsed.is_array() => parsed,
        _ => row,
    }
}

/// Render Jinja2 prompt with sample data. Sample fields are exposed at the top
/// level (LangChain convention) so `{{ word }}` works directly. Samples must
/// be JSON objects — arrays/scalars have no fields to spread and are rejected.
/// Strict undefined behavior surfaces typos as errors instead of silently
/// substituting empty strings, which previously caused the LLM to hallucinate
/// plausible defaults for missing fields.
fn render_prompt(template: &str, sample: &serde_json::Value) -> Result<String, String> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Strict);

    let obj = sample.as_object().ok_or_else(|| {
        "Sample must be a JSON object (template variables come from its fields)".to_string()
    })?;
    let mut ctx_map: std::collections::HashMap<String, MjValue> = std::collections::HashMap::new();
    for (k, v) in obj {
        ctx_map.insert(k.clone(), MjValue::from_serialize(v));
    }

    debug!(
        "Template content (first 300 chars): {}",
        &template.chars().take(300).collect::<String>()
    );
    debug!("Sample data: {:?}", sample);

    env.add_template("prompt", template)
        .map_err(|e| format!("Failed to parse template: {:#}", e))?;

    let rendered = env
        .get_template("prompt")
        .map_err(|e| format!("Failed to load template: {:#}", e))?
        .render(MjValue::from_serialize(&ctx_map))
        .map_err(|e| format!("Failed to render template: {:#}", e))?;

    debug!(
        "Rendered prompt (first 500 chars): {}",
        &rendered.chars().take(500).collect::<String>()
    );
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_content_falls_back_to_reasoning_when_content_empty() {
        // Real-world Qwen3 response shape: model put the JSON in
        // reasoning_content and left content empty.
        let body = r#"{
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "{\"word\":\"gehen\"}"
                }
            }]
        }"#;
        let resp: LlmResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.choices[0].message.extract_content(), "{\"word\":\"gehen\"}");
    }

    #[test]
    fn extract_content_prefers_content_when_present() {
        let body = r#"{
            "choices": [{
                "message": {
                    "content": "real answer",
                    "reasoning_content": "internal monologue"
                }
            }]
        }"#;
        let resp: LlmResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.choices[0].message.extract_content(), "real answer");
    }

    #[test]
    fn extract_content_handles_missing_fields() {
        let body = r#"{"choices": [{"message": {"role": "assistant"}}]}"#;
        let resp: LlmResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.choices[0].message.extract_content(), "");
    }

    #[test]
    fn render_prompt_exposes_sample_fields_at_top_level() {
        let sample = serde_json::json!({"word": "gehen", "language": "German"});
        let out = render_prompt("Translate {{ word }} ({{ language }})", &sample).unwrap();
        assert_eq!(out, "Translate gehen (German)");
    }

    #[test]
    fn render_prompt_errors_on_undefined_variable() {
        // Previously: silently rendered as "" and the LLM hallucinated a default.
        let sample = serde_json::json!({"word": "gehen"});
        let err = render_prompt("{{ language }}", &sample).unwrap_err();
        assert!(err.contains("language") || err.contains("undefined"), "got: {err}");
    }

    #[test]
    fn render_prompt_rejects_non_object_sample() {
        let err = render_prompt("{{ x }}", &serde_json::json!([1, 2, 3])).unwrap_err();
        assert!(err.contains("must be a JSON object"), "got: {err}");
    }

    #[test]
    fn parse_content_field_unwraps_json_object_string() {
        let row = serde_json::json!({
            "content": r#"{"word_de": "gehen", "word_en": "to go"}"#,
            "model": "bonsai-8b",
            "sample_index": 0,
        });
        let parsed = parse_content_field(row);
        assert_eq!(parsed["word_de"], "gehen");
        assert_eq!(parsed["word_en"], "to go");
        assert!(parsed.get("model").is_none());
        assert!(parsed.get("sample_index").is_none());
    }

    #[test]
    fn parse_content_field_unwraps_json_array_string() {
        let row = serde_json::json!({"content": "[1, 2, 3]"});
        let parsed = parse_content_field(row);
        assert_eq!(parsed, serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn parse_content_field_leaves_non_json_strings_alone() {
        let row = serde_json::json!({"content": "just plain prose, not JSON"});
        let parsed = parse_content_field(row.clone());
        assert_eq!(parsed, row);
    }

    #[test]
    fn parse_content_field_leaves_scalar_json_alone() {
        let row = serde_json::json!({"content": "42"});
        let parsed = parse_content_field(row.clone());
        assert_eq!(parsed["content"], "42");
    }

    #[test]
    fn parse_content_field_passthrough_when_no_content() {
        let row = serde_json::json!({"foo": "bar"});
        let parsed = parse_content_field(row.clone());
        assert_eq!(parsed, row);
    }

    #[test]
    fn apply_strategy_single_returns_first_only() {
        let samples = vec![
            serde_json::json!({"i": 0}),
            serde_json::json!({"i": 1}),
            serde_json::json!({"i": 2}),
        ];
        let out = JobExecutor::apply_strategy(samples, &SamplingStrategy::Single, 99);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["i"], 0);
    }

    #[test]
    fn apply_strategy_single_on_empty_returns_empty() {
        let out = JobExecutor::apply_strategy(vec![], &SamplingStrategy::Single, 5);
        assert!(out.is_empty());
    }

    #[test]
    fn apply_strategy_exhaustive_runs_every_row_once_by_default() {
        let samples = vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)];
        let out = JobExecutor::apply_strategy(samples, &SamplingStrategy::Exhaustive, 1);
        assert_eq!(out, vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)]);
    }

    #[test]
    fn apply_strategy_exhaustive_repeats_each_row_when_limit_gt_one() {
        let samples = vec![serde_json::json!("a"), serde_json::json!("b")];
        let out = JobExecutor::apply_strategy(samples, &SamplingStrategy::Exhaustive, 3);
        assert_eq!(
            out,
            vec![
                serde_json::json!("a"),
                serde_json::json!("a"),
                serde_json::json!("a"),
                serde_json::json!("b"),
                serde_json::json!("b"),
                serde_json::json!("b"),
            ]
        );
    }

    #[test]
    fn apply_strategy_exhaustive_zero_limit_treated_as_one() {
        let samples = vec![serde_json::json!(1), serde_json::json!(2)];
        let out = JobExecutor::apply_strategy(samples, &SamplingStrategy::Exhaustive, 0);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn apply_strategy_random_returns_count_without_replacement() {
        let samples: Vec<_> = (0..10).map(serde_json::Value::from).collect();
        let out = JobExecutor::apply_strategy(samples, &SamplingStrategy::Random, 4);
        assert_eq!(out.len(), 4);
        let mut seen: Vec<i64> = out.iter().map(|v| v.as_i64().unwrap()).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 4);
    }

    async fn make_executor() -> (JobExecutor, std::path::PathBuf) {
        use std::env;
        use uuid::Uuid;
        let project_dir = env::temp_dir().join(format!("ns_exec_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(project_dir.join(".nightshift")).unwrap();
        let db = DatabaseState::new(&project_dir).await.expect("db");
        let exec = JobExecutor { db, queue: Arc::new(JobQueue::new()), client: Client::new() };
        (exec, project_dir)
    }

    async fn make_collection(exec: &JobExecutor, status: &str, items: &[&str]) -> i64 {
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(format!("job-{}", status))
        .bind("p.j2").bind("d.jsonl").bind("Local").bind("m").bind("http://x")
        .bind("Unstructured").bind(1).bind("Single").bind(status)
        .execute(&exec.db.pool()).await.unwrap();
        let job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind(format!("job-{}", status))
            .fetch_one(&exec.db.pool())
            .await
            .unwrap();
        let cid: i64 =
            sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
                .bind(job_id)
                .bind(format!("c-{}", status))
                .fetch_one(&exec.db.pool())
                .await
                .unwrap();
        for item in items {
            sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?, ?)")
                .bind(cid)
                .bind(*item)
                .execute(&exec.db.pool())
                .await
                .unwrap();
        }
        cid
    }

    #[tokio::test]
    async fn load_collection_samples_returns_items_for_completed_source() {
        let (exec, dir) = make_executor().await;
        let cid =
            make_collection(&exec, "completed", &[r#"{"content":"hi"}"#, r#"{"content":"bye"}"#])
                .await;

        let out = exec.load_collection_samples(cid).await.unwrap();
        assert_eq!(out.len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn load_collection_samples_rejects_non_completed_source() {
        let (exec, dir) = make_executor().await;
        let cid = make_collection(&exec, "running", &[r#"{"content":"hi"}"#]).await;

        let err = exec.load_collection_samples(cid).await.unwrap_err();
        assert!(err.contains("not usable") && err.contains("running"), "got: {err}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn load_collection_samples_rejects_unknown_id() {
        let (exec, dir) = make_executor().await;
        let err = exec.load_collection_samples(99999).await.unwrap_err();
        assert!(err.contains("no longer exists"), "got: {err}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn load_samples_routes_invalid_collection_id_to_error() {
        let (exec, dir) = make_executor().await;
        let cfg = WorkerConfig {
            job_id: 1,
            job_type: "inference".into(),
            name: "n".into(),
            prompt_file: "p".into(),
            data_source: "collection:abc".into(),
            provider: "Local".into(),
            model: "m".into(),
            server_url: "http://x".into(),
            output_mode: "Unstructured".into(),
            temperature: None,
            max_tokens: None,
            thinking_budget: None,
            samples: 1,
            strategy: SamplingStrategy::Single,
            json_schema_file: None,
            transform_script_file: None,
            transform_error_mode: "stop".into(),
            transform_output_mode: "one_to_one".into(),
        };
        let err = exec.load_samples(&cfg).await.unwrap_err();
        assert!(err.contains("Invalid collection id"), "got: {err}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_writes_non_null_outputs_to_collection() {
        if crate::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"value":21}
{"value":0}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("double.js"),
            "return item.value ? { value: item.value * 2 } : null;",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'double', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/double.js', 'stop', 'one_to_one',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"
            SELECT ci.data
            FROM collection_items ci
            JOIN collections c ON c.id = ci.collection_id
            WHERE c.job_id = ?
            ORDER BY ci.id ASC
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();

        assert_eq!(rows, vec![serde_json::json!({ "value": 42 })]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_unwraps_array_outputs_when_configured() {
        if crate::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"questions":[{"content":"A","answer":"a"},{"content":"B","answer":"b"}]}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("unwrap.js"),
            "return item.questions.map((q) => ({ content: q.content, answer: q.answer }));",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'unwrap', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/unwrap.js', 'stop', 'unwrap_arrays',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"
            SELECT ci.data
            FROM collection_items ci
            JOIN collections c ON c.id = ci.collection_id
            WHERE c.job_id = ?
            ORDER BY ci.id ASC
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();

        assert_eq!(
            rows,
            vec![
                serde_json::json!({ "content": "A", "answer": "a" }),
                serde_json::json!({ "content": "B", "answer": "b" }),
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_unwraps_json_content_from_source_collection() {
        if crate::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        let source_collection_id = make_collection(
            &exec,
            "completed",
            &[r#"{"content":"{\"questions\":[{\"content\":\"A ___\",\"answer\":\"a\"},{\"content\":\"B ___\",\"answer\":\"b\"}],\"topic\":\"letters\"}","model":"test"}"#],
        )
        .await;
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("questions.js"),
            "return item.questions.map((q) => ({ topic: item.topic, content: q.content, answer: q.answer }));",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'collection-unwrap', '', ?, 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/questions.js', 'stop', 'unwrap_arrays',
                'pending')
            RETURNING id
            "#,
        )
        .bind(format!("collection:{}", source_collection_id))
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"
            SELECT ci.data
            FROM collection_items ci
            JOIN collections c ON c.id = ci.collection_id
            WHERE c.job_id = ?
            ORDER BY ci.id ASC
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();

        assert_eq!(
            rows,
            vec![
                serde_json::json!({ "topic": "letters", "content": "A ___", "answer": "a" }),
                serde_json::json!({ "topic": "letters", "content": "B ___", "answer": "b" }),
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_stop_mode_removes_partial_collection() {
        if crate::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"value":21}
{"value":0}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("fail.js"),
            "if (!item.value) throw new Error('bad row'); return { value: item.value };",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'fail', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/fail.js', 'stop', 'one_to_one',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let collection_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM collections WHERE job_id = ?")
                .bind(job_id)
                .fetch_one(&exec.db.pool())
                .await
                .unwrap();
        assert_eq!(collection_count, 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_skip_mode_records_item_failures() {
        if crate::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"value":21}
{"value":0}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("skip.js"),
            "if (!item.value) throw new Error('bad row'); return { value: item.value };",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'skip', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/skip.js', 'skip', 'one_to_one',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();

        let mut completed_event = None;
        while let Some(event) = rx.recv().await {
            if let JobEvent::Completed { success_count, failure_count, .. } = event {
                completed_event = Some((success_count, failure_count));
            }
        }

        assert_eq!(completed_event, Some((1, 1)));

        let failures = sqlx::query_as::<_, crate::database::JobFailure>(
            r#"
            SELECT id, job_id, sample_index, error, created_at
            FROM job_failures
            WHERE job_id = ?
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].sample_index, 1);
        assert!(failures[0].error.contains("bad row"));

        let output_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM collection_items ci
            JOIN collections c ON c.id = ci.collection_id
            WHERE c.job_id = ?
            "#,
        )
        .bind(job_id)
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();
        assert_eq!(output_count, 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn thinking_budget_to_effort_buckets() {
        assert_eq!(thinking_budget_to_effort(None), None);
        assert_eq!(thinking_budget_to_effort(Some(0)), None);
        assert_eq!(thinking_budget_to_effort(Some(-100)), None);
        assert_eq!(thinking_budget_to_effort(Some(500)), Some("low".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(750)), Some("low".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(1000)), Some("medium".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(1250)), Some("medium".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(1500)), Some("high".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(2000)), Some("high".to_string()));
    }
}
