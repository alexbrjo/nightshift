use minijinja::{Environment, context};
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

use crate::database::{DatabaseState, InferenceJobInput};

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

/// Sampling strategy for job execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SamplingStrategy {
    Single,
    Random(usize),
    Exhaustive,
}

impl std::str::FromStr for SamplingStrategy {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "single" => Ok(SamplingStrategy::Single),
            "random" | "random_samples" => Ok(SamplingStrategy::Random(10)), // default 10
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
    pub pre_render_url: Option<String>,
    pub pre_render_timeout: Option<u64>,
    pub pre_render_body: Option<String>,
    pub json_schema_file: Option<String>,
}

impl WorkerConfig {
    /// Create from database job record
    pub fn from_job(job: crate::database::InferenceJob) -> Self {
        let strategy = job.strategy.parse().unwrap_or(SamplingStrategy::Single);

        WorkerConfig {
            job_id: job.id,
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
            pre_render_url: job.pre_render_url,
            pre_render_timeout: job.pre_render_timeout.map(|t| t as u64),
            pre_render_body: job.pre_render_body,
            json_schema_file: job.json_schema_file,
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
        CancellationToken {
            inner: Arc::new(Mutex::new(false)),
        }
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
        JobQueue {
            jobs: RwLock::new(HashMap::new()),
            cancellations: RwLock::new(HashMap::new()),
        }
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

                // Signal cancellation
                let cancellations = self.cancellations.write().await;
                if let Some(token) = cancellations.get(&job_id) {
                    token.cancel();
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

/// LLM API request structure
#[derive(Debug, Serialize)]
struct LlmRequest {
    model: String,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<i32>,
}

#[derive(Debug, Serialize)]
struct Message {
    role: String,
    content: String,
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
    content: String,
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

        Ok(JobExecutor {
            db: db_state,
            queue: Arc::new(JobQueue::new()),
            client,
        })
    }

    /// Start an inference job asynchronously
    #[instrument(skip(self), fields(job_id))]
    pub async fn start_job(&self, job_id: i64) -> Result<(), String> {
        // Check if already running
        if self.queue.is_running(job_id).await {
            return Err("Job is already running".to_string());
        }

        // Get job from database using internal helper
        let job = crate::database::get_inference_job_by_id(&self.db.pool, job_id)
            .await?;

        let job = job.ok_or("Job not found")?;

        if job.status != "pending" && job.status != "queued" {
            return Err(format!("Job cannot be started from status: {}", job.status));
        }

        // Convert f32 to f64 for temperature (not used here, but preserved for future)

        // Update database status - use non-Option fields based on InferenceJobInput struct
        let input = InferenceJobInput {
            name: job.name.clone(),
            prompt_file: job.prompt_file.clone(),
            data_source: job.data_source.clone(),
            provider: job.provider.clone(),
            model: job.model.clone(),
            server_url: job.server_url.clone(),
            output_mode: job.output_mode.clone(),
            temperature: job.temperature,
            max_tokens: job.max_tokens,
            thinking_budget: job.thinking_budget,
            samples: job.samples,
            strategy: job.strategy.clone(),
            pre_render_url: job.pre_render_url.clone(),
            pre_render_timeout: job.pre_render_timeout,
            pre_render_body: job.pre_render_body.clone(),
            json_schema_file: job.json_schema_file.clone(),
        };

        crate::database::update_inference_job_by_id(&self.db.pool, job_id, input)
            .await?;

        // Enqueue and start
        self.queue.enqueue(job_id).await;
        self.queue.start(job_id).await;

        info!("Job {} started successfully", job_id);
        Ok(())
    }

    /// Cancel a running job
    #[instrument(skip(self), fields(job_id))]
    pub async fn cancel_job(&self, job_id: i64) -> Result<bool, String> {
        let cancelled = self.queue.cancel(job_id).await;

        if cancelled {
            // Get current job to preserve required fields
            let job_opt = crate::database::get_inference_job_by_id(&self.db.pool, job_id).await?;

            if let Some(job) = job_opt {
                // Update database status with preserved values for required fields
                let input = InferenceJobInput {
                    name: job.name,
                    prompt_file: job.prompt_file,
                    data_source: job.data_source,
                    provider: job.provider,
                    model: job.model,
                    server_url: job.server_url,
                    output_mode: job.output_mode,
                    temperature: None,
                    max_tokens: None,
                    thinking_budget: None,
                    samples: 1, // Must be > 0
                    strategy: "single".to_string(),
                    pre_render_url: None,
                    pre_render_timeout: None,
                    pre_render_body: None,
                    json_schema_file: None,
                };

                if let Err(e) = crate::database::update_inference_job_by_id(&self.db.pool, job_id, input).await {
                    warn!("Failed to update cancelled job in DB: {}", e);
                }
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
        let cancellation = self.queue.get_cancellation_token(config.job_id).await
            .ok_or("Cancellation token not found")?;

        info!("Starting job execution for {} with {} samples", config.name, config.samples);

        // Load data from source
        let samples = self.load_samples(&config).await?;
        info!("Loaded {} samples from {}", samples.len(), config.data_source);

        if samples.is_empty() {
            warn!("No samples loaded for job {}", config.job_id);
            let _ = tx.send(JobEvent::Completed { 
                job_id: config.job_id, 
                success_count: 0, 
                failure_count: 0 
            }).await;
            self.queue.complete(config.job_id).await;
            return Ok(());
        }

        let total_samples = samples.len();
        let mut completed_count = 0;
        let mut failed_count = 0;

        // Create or get collection for this job
        let collection_id = self.ensure_collection(&config).await?;
        info!("Using collection {} for job {}", collection_id, config.job_id);

        // Send started event
        if tx.send(JobEvent::Started {
            job_id: config.job_id,
            job_name: config.name.clone(),
            total_samples,
        }).await.is_err() {
            warn!("Failed to send started event");
        }

        // Process each sample
        for (index, sample) in samples.into_iter().enumerate() {
            // Check cancellation
            if cancellation.is_cancelled().await {
                info!("Job {} cancelled at sample {}/{}", config.job_id, index, total_samples);

                let _ = tx.send(JobEvent::Cancelled {
                    job_id: config.job_id,
                    completed_samples: completed_count,
                }).await;

                self.queue.complete(config.job_id).await;
                return Ok(());
            }

            // Send sample started event
            if tx.send(JobEvent::SampleStarted {
                sample_index: index,
                total_samples,
            }).await.is_err() {
                warn!("Failed to send sample started event");
            }

            // Process sample with retry logic
            match self.process_sample(&config, index, &sample, &cancellation, &tx).await {
                Ok(output) => {
                    completed_count += 1;
                    info!("Sample {} succeeded for job {} (progress: {}/{})", index, config.job_id, completed_count, total_samples);

                    // Save output to collection
                    if let Err(e) = self.save_to_collection(collection_id, &output).await {
                        warn!("Failed to save output to collection: {}", e);
                    }

                    if tx.send(JobEvent::SampleCompleted {
                        sample_index: index,
                        total_samples,
                        output: output.clone(),
                    }).await.is_err() {
                        warn!("Failed to send sample completed event");
                    }
                }
                Err(e) => {
                    failed_count += 1;
                    error!("Sample {} failed for job {}: {} (progress: {}/{})", index, config.job_id, e, completed_count, total_samples);

                    if tx.send(JobEvent::SampleFailed {
                        sample_index: index,
                        total_samples,
                        error: e.clone(),
                        retry_count: 0,
                    }).await.is_err() {
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

        // Send completion event
        info!("Sending completion event for job {}", config.job_id);
        let _ = tx.send(JobEvent::Completed {
            job_id: config.job_id,
            success_count: completed_count,
            failure_count: failed_count,
        }).await;

        info!("Marking job {} as complete in queue", config.job_id);
        self.queue.complete(config.job_id).await;

        info!("Job {} completed: {} successful, {} failed",
              config.job_id, completed_count, failed_count);

        Ok(())
    }

    /// Ensure collection exists for job
    async fn ensure_collection(&self, config: &WorkerConfig) -> Result<i64, String> {
        // Check if collection already exists
        let existing: Option<(i64,)> = sqlx::query_as(
            r#"SELECT id FROM collections WHERE job_id = ? LIMIT 1"#
        )
        .bind(config.job_id)
        .fetch_optional(&self.db.pool)
        .await
        .map_err(|e| format!("Failed to check collection: {}", e))?;

        if let Some((collection_id,)) = existing {
            return Ok(collection_id);
        }

        // Create new collection
        sqlx::query(
            r#"INSERT INTO collections (job_id, name) VALUES (?, ?)"#
        )
        .bind(config.job_id)
        .bind(format!("{} outputs", config.name))
        .execute(&self.db.pool)
        .await
        .map_err(|e| format!("Failed to create collection: {}", e))?;

        // Get the new collection ID
        let result: (i64,) = sqlx::query_as(
            r#"SELECT id FROM collections WHERE job_id = ? LIMIT 1"#
        )
        .bind(config.job_id)
        .fetch_one(&self.db.pool)
        .await
        .map_err(|e| format!("Failed to get collection ID: {}", e))?;

        Ok(result.0)
    }

    /// Save output to collection
    async fn save_to_collection(&self, collection_id: i64, data: &serde_json::Value) -> Result<(), String> {
        sqlx::query(
            r#"INSERT INTO collection_items (collection_id, data) VALUES (?, ?)"#
        )
        .bind(collection_id)
        .bind(data)
        .execute(&self.db.pool)
        .await
        .map_err(|e| format!("Failed to save collection item: {}", e))?;

        Ok(())
    }

    /// Load samples from data source file
    async fn load_samples(&self, config: &WorkerConfig) -> Result<Vec<serde_json::Value>, String> {
        debug!("Loading samples from data source: {} with strategy: {:?}", config.data_source, config.strategy);

        // Resolve the data source path - use as-is if absolute, otherwise relative to project root
        let full_path = if std::path::Path::new(&config.data_source).is_absolute() {
            std::path::PathBuf::from(&config.data_source)
        } else {
            self.db.get_project_root().join(&config.data_source)
        };
        
        debug!("Full data source path: {}", full_path.display());
        
        // Check if file exists
        if !full_path.exists() {
            return Err(format!("Data source file does not exist: {}", full_path.display()));
        }
        
        // Read the file content
        let content = tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|e| format!("Failed to read data source {}: {}", config.data_source, e))?;

        // Parse based on format (JSONL or JSON array)
        let mut samples: Vec<serde_json::Value> = Vec::new();
        
        if content.trim().starts_with('[') {
            // JSON array format
            let parsed: Vec<serde_json::Value> = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse JSON array from {}: {}", config.data_source, e))?;
            samples = parsed;
        } else {
            // JSONL format (one JSON object per line)
            for (line_num, line) in content.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue; // Skip empty lines and comments
                }
                
                match serde_json::from_str(trimmed) {
                    Ok(obj) => samples.push(obj),
                    Err(e) => {
                        warn!("Failed to parse line {} in {}: {}", line_num + 1, config.data_source, e);
                    }
                }
            }
        }

        debug!("Loaded {} samples from {}", samples.len(), config.data_source);
        
        // Log first sample for debugging
        if let Some(first) = samples.first() {
            debug!("First sample keys: {:?}", first.as_object().map(|o| o.keys().collect::<Vec<_>>()));
            debug!("First sample content: {:?}", first);
        } else {
            warn!("No samples loaded from data source!");
        }

        // Apply sampling strategy
        match &config.strategy {
            SamplingStrategy::Single => {
                // Return first sample only
                Ok(samples.into_iter().next().map(|s| vec![s]).unwrap_or_default())
            }
            SamplingStrategy::Random(n) => {
                // Return random samples
                let count = (*n).min(samples.len());
                if count == 0 || samples.is_empty() {
                    return Ok(Vec::new());
                }
                
                let mut rng = rand::rng();
                let mut indices: Vec<usize> = (0..samples.len()).collect();
                indices.shuffle(&mut rng);
                
                let selected: Vec<serde_json::Value> = indices
                    .into_iter()
                    .take(count)
                    .map(|i| samples[i].clone())
                    .collect();
                
                Ok(selected)
            }
            SamplingStrategy::Exhaustive => {
                // Return all samples (up to config.samples limit if specified)
                let count = if config.samples > 0 {
                    config.samples as usize
                } else {
                    samples.len()
                };
                Ok(samples.into_iter().take(count).collect())
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

        info!("Processing sample {}/{} for job {}", sample_index + 1, config.samples, config.job_id);

        for attempt in 0..=max_retries {
            // Check cancellation before each attempt
            if cancellation.is_cancelled().await {
                return Err("Cancelled".to_string());
            }

            debug!("Attempting LLM call for sample {} (attempt {}/{})", sample_index + 1, attempt + 1, max_retries + 1);
            match self.attempt_llm_call(config, sample_index, sample).await {
                Ok(output) => return Ok(output),
                Err(e) => {
                    let is_rate_limit = e.contains("429") || e.contains("rate limit");

                    if attempt < max_retries && is_rate_limit {
                        let delay = base_delay * 2u32.pow(attempt as u32); // Exponential backoff

                        info!("Rate limited, retrying sample {} in {:?} (attempt {}/{})",
                              sample_index, delay, attempt + 1, max_retries);

                        if tx.send(JobEvent::SampleFailed {
                            sample_index,
                            total_samples: 0, // Will be updated by caller
                            error: e.clone(),
                            retry_count: attempt + 1,
                        }).await.is_err() {
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
        // Validate server URL
        if Url::parse(&config.server_url).is_err() {
            return Err(format!("Invalid server URL: {}", config.server_url));
        }

        // Render prompt with sample data using MiniJinja
        let prompt_content = self.load_prompt_file(&config.prompt_file).await?;
        let rendered_prompt = self.render_prompt(&prompt_content, sample)?;

        // Build request
        let messages = vec![Message {
            role: "user".to_string(),
            content: rendered_prompt,
        }];

        let request = LlmRequest {
            model: config.model.clone(),
            messages,
            temperature: config.temperature,
            max_tokens: config.max_tokens,
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
        let response = self.client
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
        let response_text = response.text().await.map_err(|e| format!("Failed to read response body: {}", e))?;
        debug!("LLM response body: {}", &response_text);
        
        let llm_response: LlmResponse = serde_json::from_str(&response_text)
            .map_err(|e| format!("Failed to parse response JSON ({}): {}", e, response_text))?;

        // Extract content from response
        if let Some(choice) = llm_response.choices.first() {
            Ok(serde_json::json!({
                "content": choice.message.content,
                "model": config.model,
                "sample_index": sample_index as i64,
            }))
        } else {
            Err("No choices in response".to_string())
        }
    }

    /// Load prompt from file
    async fn load_prompt_file(&self, path: &str) -> Result<String, String> {
        // Resolve the path - use as-is if absolute, otherwise relative to project root
        let full_path = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            self.db.get_project_root().join(path)
        };
        
        debug!("Loading prompt from: {} (resolved to: {})", path, full_path.display());
        debug!("File exists: {}", full_path.exists());
        
        if !full_path.exists() {
            return Err(format!("Prompt file does not exist: {}", full_path.display()));
        }
        
        let content = tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|e| format!("Failed to read prompt file {}: {}", path, e))?;
        
        debug!("Prompt file loaded successfully ({} bytes)", content.len());
        Ok(content)
    }

    /// Render Jinja2 prompt with sample data
    fn render_prompt(&self, template: &str, sample: &serde_json::Value) -> Result<String, String> {
        let mut env = Environment::new();

        // Convert serde_json::Value to minijinja context
        let ctx = context! {
            data => sample,
        };

        debug!("Template content (first 300 chars): {}", &template.chars().take(300).collect::<String>());
        debug!("Sample data: {:?}", sample);

        env.add_template("prompt", template)
            .map_err(|e| format!("Failed to parse template: {}", e))?;

        let rendered = env.get_template("prompt")
            .map_err(|e| format!("Failed to load template: {}", e))?
            .render(&ctx)
            .map_err(|e| format!("Failed to render template: {}", e))?;
        
        debug!("Rendered prompt (first 500 chars): {}", &rendered.chars().take(500).collect::<String>());
        Ok(rendered)
    }
}
