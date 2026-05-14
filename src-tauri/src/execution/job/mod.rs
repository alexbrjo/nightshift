mod prompt;
mod types;

#[cfg(test)]
mod tests;

use prompt::render_prompt;
use types::CancellationToken;
pub use types::{JobEvent, JobProgress, JobQueue, JobStatus, WorkerConfig};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use tracing::{debug, error, info, instrument, warn};
use url::Url;

use crate::database::DatabaseState;
use crate::execution::sampling;
use crate::execution::transform_runner;

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
        Self::from_database((*db).clone())
    }

    pub fn from_database(db_state: DatabaseState) -> Result<Self, String> {
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
        if config.job_type == "sample" {
            return self.execute_sample_job(config, tx).await;
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

                    // Save output to the rebuildable job output index. Method executions
                    // also mirror SampleCompleted events into execution JSONL.
                    if let Err(e) = self.save_to_job_outputs(config.job_id, &output).await {
                        warn!("Failed to save output: {}", e);
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
                        self.save_transform_output(config.job_id, &config, &output).await
                    {
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

    async fn execute_sample_job(
        &self,
        config: WorkerConfig,
        tx: mpsc::Sender<JobEvent>,
    ) -> Result<(), String> {
        let cancellation = self
            .queue
            .get_cancellation_token(config.job_id)
            .await
            .ok_or("Cancellation token not found")?;

        let samples = self.load_samples(&config).await?;
        let total_samples = samples.len();
        let _ = tx
            .send(JobEvent::Started {
                job_id: config.job_id,
                job_name: config.name.clone(),
                total_samples,
            })
            .await;

        let mut completed_count = 0;
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
            self.save_to_job_outputs(config.job_id, &sample).await?;
            completed_count += 1;
            let _ = tx
                .send(JobEvent::SampleCompleted {
                    sample_index: index,
                    total_samples,
                    output: sample,
                })
                .await;

            let progress = JobProgress {
                job_id: config.job_id,
                job_name: config.name.clone(),
                status: JobStatus::Running,
                current_sample: index + 1,
                total_samples,
                completed_samples: completed_count,
                failed_samples: 0,
                overall_progress: if total_samples == 0 {
                    1.0
                } else {
                    (index + 1) as f64 / total_samples as f64
                },
            };
            let _ = tx.send(JobEvent::ProgressUpdate(progress)).await;
        }

        let _ = tx
            .send(JobEvent::Completed {
                job_id: config.job_id,
                success_count: completed_count,
                failure_count: 0,
            })
            .await;

        self.queue.complete(config.job_id).await;
        Ok(())
    }

    /// Save output to the job output index. Canonical Method execution output
    /// JSONL is written by the Method execution layer from emitted job events.
    async fn save_to_job_outputs(
        &self,
        job_id: i64,
        data: &serde_json::Value,
    ) -> Result<(), String> {
        sqlx::query(r#"INSERT INTO job_outputs (job_id, data) VALUES (?, ?)"#)
            .bind(job_id)
            .bind(data)
            .execute(&self.db.pool())
            .await
            .map_err(|e| format!("Failed to save job output: {}", e))?;

        Ok(())
    }

    async fn save_transform_output(
        &self,
        job_id: i64,
        config: &WorkerConfig,
        data: &serde_json::Value,
    ) -> Result<(), String> {
        if config.transform_output_mode == "unwrap_arrays" {
            if let serde_json::Value::Array(items) = data {
                for item in items {
                    self.save_to_job_outputs(job_id, item).await?;
                }
                return Ok(());
            }
        }

        self.save_to_job_outputs(job_id, data).await
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

    async fn load_samples(&self, config: &WorkerConfig) -> Result<Vec<serde_json::Value>, String> {
        sampling::load_samples(&self.db, &config.data_source, &config.strategy, config.samples)
            .await
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
