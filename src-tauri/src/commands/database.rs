use tauri::State;

use crate::database::{
    DatabaseState, InferenceJob, InferenceJobInput, JobFailure, TransformJobInput,
};

#[tauri::command]
pub async fn create_inference_job(
    state: State<'_, DatabaseState>,
    input: InferenceJobInput,
) -> Result<i64, String> {
    crate::database::create_inference_job(state, input).await
}

#[tauri::command]
pub async fn create_transform_job(
    state: State<'_, DatabaseState>,
    input: TransformJobInput,
) -> Result<i64, String> {
    crate::database::create_transform_job(state, input).await
}

#[tauri::command]
pub async fn get_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
) -> Result<Option<InferenceJob>, String> {
    crate::database::get_inference_job(state, id).await
}

#[tauri::command]
pub async fn list_inference_jobs(
    state: State<'_, DatabaseState>,
    page: i32,
    page_size: i32,
) -> Result<Vec<InferenceJob>, String> {
    crate::database::list_inference_jobs(state, page, page_size).await
}

#[tauri::command]
pub async fn update_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
    input: InferenceJobInput,
) -> Result<bool, String> {
    crate::database::update_inference_job(state, id, input).await
}

#[tauri::command]
pub async fn get_job_failures(
    state: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<Vec<JobFailure>, String> {
    crate::database::get_job_failures(state, job_id).await
}

#[tauri::command]
pub async fn delete_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
) -> Result<bool, String> {
    crate::database::delete_inference_job(state, id).await
}
