use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::database::{self, DatabaseState};
use crate::job_executor::{JobEvent, JobExecutor, WorkerConfig};
use crate::state::JobManager;

/// Spawn the event-broadcast and execution tasks for a job whose queue entry
/// has already been marked Running via `executor.start_job`.
fn spawn_job_execution(executor: &JobExecutor, app: AppHandle, config: WorkerConfig) {
    let (tx, mut rx) = mpsc::channel::<JobEvent>(100);
    let app_clone = app.clone();
    let pool = executor.db.pool();

    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let event_name = match &event {
                JobEvent::Started { .. } => "job-started",
                JobEvent::SampleStarted { .. } => "sample-started",
                JobEvent::SampleCompleted { .. } => "sample-completed",
                JobEvent::SampleFailed { .. } => "sample-failed",
                JobEvent::ProgressUpdate(_) => "job-progress",
                JobEvent::Completed { .. } => "job-completed",
                JobEvent::Failed { .. } => "job-failed",
                JobEvent::Cancelled { .. } => "job-cancelled",
            };

            match &event {
                JobEvent::Completed { job_id, success_count, failure_count } => {
                    tracing::info!("Job {} completed: {} successful, {} failed", job_id, success_count, failure_count);
                    if let Err(e) = database::update_job_status(&pool, *job_id, "completed").await {
                        tracing::error!("Failed to update job {} status to completed: {}", job_id, e);
                    }
                }
                JobEvent::Failed { job_id, error } => {
                    tracing::error!("Job {} failed: {}", job_id, error);
                    if let Err(e) = database::update_job_status_with_error(&pool, *job_id, &format!("Failed: {}", error)).await {
                        tracing::error!("Failed to update job {} status to failed: {}", job_id, e);
                    }
                }
                JobEvent::Cancelled { job_id, .. } => {
                    if let Err(e) = database::update_job_status(&pool, *job_id, "cancelled").await {
                        tracing::error!("Failed to update job {} status to cancelled: {}", job_id, e);
                    }
                }
                _ => {}
            }

            if let Err(e) = app_clone.emit(event_name, event) {
                tracing::warn!("Failed to emit job event: {}", e);
            }
        }
    });

    let executor_clone = executor.clone();
    tokio::spawn(async move {
        if let Err(e) = executor_clone.execute_job(config, tx).await {
            tracing::error!("Job execution failed: {}", e);
        }
    });
}

/// Start an inference job asynchronously, emitting progress events to the frontend.
#[tauri::command]
pub async fn start_inference_job(
    app: AppHandle,
    job_manager: State<'_, JobManager>,
    db: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<(), String> {
    let mut executor_opt = job_manager.executor.lock().await;
    if executor_opt.is_none() {
        *executor_opt = Some(JobExecutor::new(db.clone())?);
    }
    let executor = executor_opt.as_ref().unwrap();

    executor.start_job(job_id).await?;

    let job = database::get_inference_job(db.clone(), job_id).await
        .map_err(|e| format!("Failed to get job: {}", e))?
        .ok_or("Job not found")?;
    let config = WorkerConfig::from_job(job);

    spawn_job_execution(executor, app, config);
    Ok(())
}

/// Cancel a running inference job
#[tauri::command]
pub async fn cancel_inference_job(
    job_manager: State<'_, JobManager>,
    db: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<bool, String> {
    // Initialize executor if not already done
    let mut executor_opt = job_manager.executor.lock().await;
    if executor_opt.is_none() {
        *executor_opt = Some(JobExecutor::new(db.clone())?);
    }
    
    let executor = executor_opt.as_ref().unwrap();
    
    // Cancel the job
    let cancelled = executor.cancel_job(job_id).await?;
    
    Ok(cancelled)
}

/// Start a job and subscribe to its status updates. Equivalent to `start_inference_job`;
/// kept as a separate command for the existing frontend wiring.
#[tauri::command]
pub async fn subscribe_to_job_status(
    app: AppHandle,
    job_manager: State<'_, JobManager>,
    db: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<(), String> {
    start_inference_job(app, job_manager, db, job_id).await
}

/// Export a job configuration to YAML format
#[tauri::command]
pub async fn export_job_to_yaml(
    db: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<String, String> {
    // Get job from database
    let job = database::get_inference_job(db.clone(), job_id).await
        .map_err(|e| format!("Failed to get job: {}", e))?;
    
    let job = job.ok_or("Job not found")?;
    
    // Convert to a serializable format
    #[derive(serde::Serialize)]
    struct JobConfig {
        name: String,
        prompt_file: String,
        data_source: String,
        provider: String,
        model: String,
        server_url: String,
        output_mode: String,
        temperature: Option<f32>,
        max_tokens: Option<i32>,
        thinking_budget: Option<i32>,
        samples: i32,
        strategy: String,
        pre_render: Option<PreRenderConfig>,
        json_schema_file: Option<String>,
    }

    #[derive(serde::Serialize)]
    struct PreRenderConfig {
        url: String,
        timeout: Option<i32>,
        body: Option<String>,
    }

    let pre_render = if job.pre_render_url.is_some() {
        Some(PreRenderConfig {
            url: job.pre_render_url.unwrap_or_default(),
            timeout: job.pre_render_timeout,
            body: job.pre_render_body,
        })
    } else {
        None
    };

    let config = JobConfig {
        name: job.name,
        prompt_file: job.prompt_file,
        data_source: job.data_source,
        provider: job.provider,
        model: job.model,
        server_url: job.server_url,
        output_mode: job.output_mode,
        temperature: job.temperature,
        max_tokens: job.max_tokens,
        thinking_budget: job.thinking_budget,
        samples: job.samples,
        strategy: job.strategy,
        pre_render,
        json_schema_file: job.json_schema_file,
    };

    // Serialize to YAML
    serde_yaml::to_string(&config)
        .map_err(|e| format!("Failed to serialize to YAML: {}", e))
}

/// List all prompt files (.jinja2, .prompt, .j2) in a directory tree
#[tauri::command]
pub async fn list_prompt_files(
    base_path: String,
) -> Result<Vec<String>, String> {
    use std::path::PathBuf;
    
    let mut prompt_files = Vec::new();
    let base = PathBuf::from(&base_path);
    
    // Walk the directory tree looking for .jinja2 and .prompt files
    fn walk_dir(dir: &std::path::Path, prompts: &mut Vec<String>, base: &std::path::Path) -> Result<(), String> {
        if !dir.is_dir() {
            return Ok(());
        }
        
        let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
        
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();
            
            if path.is_dir() {
                // Skip hidden directories and common non-code directories
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.') || 
                       name == "node_modules" || 
                       name == ".git" || 
                       name == "target" ||
                       name == "dist" {
                        continue;
                    }
                }
                walk_dir(&path, prompts, base)?;
            } else if path.is_file() {
                // Check for prompt file extensions
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if ext == "jinja2" || ext == "prompt" || ext == "j2" {
                        // Convert to relative path from base
                        if let Ok(relative) = path.strip_prefix(base) {
                            if let Some(path_str) = relative.to_str() {
                                prompts.push(path_str.to_string());
                            }
                        }
                    }
                }
            }
        }
        
        Ok(())
    }
    
    walk_dir(&base, &mut prompt_files, &base)?;
    
    // Sort alphabetically
    prompt_files.sort();
    
    Ok(prompt_files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::fs;
    use std::env;
    use uuid::Uuid;

    #[tokio::test]
    async fn list_prompt_files_finds_correct_files() {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_project_dir = temp_dir.join(format!("nightshift_prompts_test_{}", unique_id));
        
        // Create directory structure with prompt files
        fs::create_dir_all(test_project_dir.join("prompts")).unwrap();
        fs::create_dir_all(test_project_dir.join("templates")).unwrap();
        
        fs::write(test_project_dir.join("prompts").join("test.jinja2"), "test").unwrap();
        fs::write(test_project_dir.join("prompts").join("another.prompt"), "test").unwrap();
        fs::write(test_project_dir.join("templates").join("old.j2"), "test").unwrap();
        
        // Create some files that should be ignored
        fs::write(test_project_dir.join("readme.md"), "test").unwrap();
        fs::create_dir_all(test_project_dir.join(".git")).unwrap();
        fs::write(test_project_dir.join(".git").join("config"), "test").unwrap();

        let result = list_prompt_files(test_project_dir.to_string_lossy().to_string()).await.unwrap();
        
        assert_eq!(result.len(), 3);
        assert!(result.contains(&"prompts/test.jinja2".to_string()));
        assert!(result.contains(&"prompts/another.prompt".to_string()));
        assert!(result.contains(&"templates/old.j2".to_string()));

        // Cleanup
        fs::remove_dir_all(&test_project_dir).ok();
    }

    #[tokio::test]
    async fn list_prompt_files_handles_empty_directory() {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_project_dir = temp_dir.join(format!("nightshift_empty_prompts_test_{}", unique_id));
        
        fs::create_dir_all(&test_project_dir).unwrap();

        let result = list_prompt_files(test_project_dir.to_string_lossy().to_string()).await.unwrap();
        
        assert!(result.is_empty());

        // Cleanup
        fs::remove_dir_all(&test_project_dir).ok();
    }
}
