use sqlx::SqlitePool;
use tauri::State;

use super::{
    validation::{validate_inference_job_input, validate_transform_job_input},
    DatabaseState, InferenceJob, InferenceJobInput, JobFailure, TransformJobInput,
};

pub async fn create_inference_job(
    state: State<'_, DatabaseState>,
    input: InferenceJobInput,
) -> Result<i64, String> {
    validate_inference_job_input(&input)?;

    tracing::info!(
        "Creating inference job: {} with prompt file: {}",
        input.name,
        input.prompt_file
    );

    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, temperature, max_tokens, thinking_budget, samples, strategy,
            json_schema_file, status
        )
        VALUES (
            'inference', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending'
        )
        "#,
    )
    .bind(&input.name)
    .bind(&input.prompt_file)
    .bind(&input.data_source)
    .bind(&input.provider)
    .bind(&input.model)
    .bind(&input.server_url)
    .bind(&input.output_mode)
    .bind(input.temperature)
    .bind(input.max_tokens)
    .bind(input.thinking_budget)
    .bind(input.samples)
    .bind(&input.strategy)
    .bind(&input.json_schema_file)
    .execute(&state.pool())
    .await;

    match result {
        Ok(result) => {
            tracing::info!(
                "Successfully created inference job with ID: {}",
                result.last_insert_rowid()
            );
            Ok(result.last_insert_rowid())
        }
        Err(e) => {
            let error_msg = format!("Failed to create inference job: {}", e);
            tracing::error!("{}", error_msg);

            // Check for unique constraint violation
            if e.to_string().contains("UNIQUE constraint failed") {
                return Err(format!(
                    "A job with the name '{}' already exists. Please choose a different name.",
                    input.name
                ));
            }

            Err(error_msg)
        }
    }
}

/// Tauri command to create a new transform job.
pub async fn create_transform_job(
    state: State<'_, DatabaseState>,
    input: TransformJobInput,
) -> Result<i64, String> {
    validate_transform_job_input(&input)?;

    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, transform_script_file, transform_error_mode,
            transform_output_mode, status
        )
        VALUES (
            'transform', ?1, '', ?2, 'Nightshift', 'JavaScript', '', 'Transform',
            1, 'exhaustive', ?3, ?4, ?5, 'pending'
        )
        "#,
    )
    .bind(&input.name)
    .bind(&input.data_source)
    .bind(&input.script_file)
    .bind(&input.error_mode)
    .bind(&input.output_mode)
    .execute(&state.pool())
    .await;

    match result {
        Ok(result) => Ok(result.last_insert_rowid()),
        Err(e) => {
            if e.to_string().contains("UNIQUE constraint failed") {
                return Err(format!(
                    "A job with the name '{}' already exists. Please choose a different name.",
                    input.name
                ));
            }
            Err(format!("Failed to create transform job: {}", e))
        }
    }
}

/// Internal helper to get an inference job by ID (works with SqlitePool directly)
pub async fn get_inference_job_by_id(
    pool: &SqlitePool,
    id: i64,
) -> Result<Option<InferenceJob>, String> {
    let job = sqlx::query_as::<_, InferenceJob>(
        r#"
        SELECT * FROM inference_jobs WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch inference job: {}", e))?;

    Ok(job)
}

/// Tauri command to get an inference job by ID
pub async fn get_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
) -> Result<Option<InferenceJob>, String> {
    get_inference_job_by_id(&state.pool(), id).await
}

/// Tauri command to list all inference jobs with pagination
pub async fn list_inference_jobs(
    state: State<'_, DatabaseState>,
    page: i32,
    page_size: i32,
) -> Result<Vec<InferenceJob>, String> {
    let offset = (page - 1) * page_size;

    let jobs = sqlx::query_as::<_, InferenceJob>(
        r#"
        SELECT * FROM inference_jobs
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        "#,
    )
    .bind(page_size)
    .bind(offset)
    .fetch_all(&state.pool())
    .await
    .map_err(|e| format!("Failed to list inference jobs: {}", e))?;

    Ok(jobs)
}

/// Internal helper to update an inference job (works with SqlitePool directly)
pub async fn update_inference_job_by_id(
    pool: &SqlitePool,
    id: i64,
    input: InferenceJobInput,
) -> Result<bool, String> {
    validate_inference_job_input(&input)?;

    let result = sqlx::query(
        r#"
        UPDATE inference_jobs SET
            name = ?1,
            prompt_file = ?2,
            data_source = ?3,
            provider = ?4,
            model = ?5,
            server_url = ?6,
            output_mode = ?7,
            temperature = ?8,
            max_tokens = ?9,
            thinking_budget = ?10,
            samples = ?11,
            strategy = ?12,
            json_schema_file = ?13,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?14
        "#,
    )
    .bind(&input.name)
    .bind(&input.prompt_file)
    .bind(&input.data_source)
    .bind(&input.provider)
    .bind(&input.model)
    .bind(&input.server_url)
    .bind(&input.output_mode)
    .bind(input.temperature)
    .bind(input.max_tokens)
    .bind(input.thinking_budget)
    .bind(input.samples)
    .bind(&input.strategy)
    .bind(&input.json_schema_file)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update inference job: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Tauri command to update an inference job
pub async fn update_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
    input: InferenceJobInput,
) -> Result<bool, String> {
    update_inference_job_by_id(&state.pool(), id, input).await
}

/// Update just the job status (internal helper)
pub async fn update_job_status(pool: &SqlitePool, id: i64, status: &str) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE inference_jobs
        SET status = ?, updated_at = datetime('now')
        WHERE id = ?
        "#,
    )
    .bind(status)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update job status: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Update job status with error message (internal helper)
pub async fn update_job_status_with_error(
    pool: &SqlitePool,
    id: i64,
    error: &str,
) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE inference_jobs
        SET status = 'failed', error_message = ?, updated_at = datetime('now')
        WHERE id = ?
        "#,
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update job status: {}", e))?;

    Ok(result.rows_affected() > 0)
}

pub async fn clear_job_failures(pool: &SqlitePool, job_id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM job_failures WHERE job_id = ?")
        .bind(job_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to clear job failures: {}", e))?;
    Ok(())
}

pub async fn add_job_failure(
    pool: &SqlitePool,
    job_id: i64,
    sample_index: usize,
    error: &str,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO job_failures (job_id, sample_index, error)
        VALUES (?1, ?2, ?3)
        "#,
    )
    .bind(job_id)
    .bind(sample_index as i64)
    .bind(error)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to record job failure: {}", e))?;
    Ok(())
}

pub async fn get_job_failures(
    state: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<Vec<JobFailure>, String> {
    sqlx::query_as::<_, JobFailure>(
        r#"
        SELECT id, job_id, sample_index, error, created_at
        FROM job_failures
        WHERE job_id = ?
        ORDER BY sample_index ASC, id ASC
        "#,
    )
    .bind(job_id)
    .fetch_all(&state.pool())
    .await
    .map_err(|e| format!("Failed to fetch job failures: {}", e))
}

/// Tauri command to delete an inference job
pub async fn delete_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        DELETE FROM inference_jobs WHERE id = ?
        "#,
    )
    .bind(id)
    .execute(&state.pool())
    .await
    .map_err(|e| format!("Failed to delete inference job: {}", e))?;

    Ok(result.rows_affected() > 0)
}
