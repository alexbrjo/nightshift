use crate::db::{AppState, DbError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use sqlx::Row;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct OpenProjectParams {
    path: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    id: i64,
    name: String,
    path: String,
}

#[tauri::command]
pub async fn open_project(
    state: State<'_, AppState>,
    params: OpenProjectParams,
) -> Result<ProjectInfo> {
    let path = PathBuf::from(&params.path);
    
    if !path.exists() || !path.is_dir() {
        return Err(DbError::ProjectNotFound(params.path));
    }

    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".to_string());

    sqlx::query::<_>(
        r#"
        INSERT OR REPLACE INTO projects (path, name)
        VALUES (?, ?)
        "#,
    )
    .bind(&params.path)
    .bind(&name)
    .execute(state.pool.clone().inner())
    .await?;

    state.project_path = Some(params.path.clone());

    Ok(ProjectInfo {
        id: 1,
        name,
        path: params.path,
    })
}

#[derive(Debug, Deserialize)]
pub struct ReadFileParams {
    path: String,
}

#[derive(Debug, Serialize)]
pub struct FileContent {
    content: String,
    path: String,
    language: String,
}

#[tauri::command]
pub async fn read_file(
    state: State<'_, AppState>,
    params: ReadFileParams,
) -> Result<FileContent> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| DbError::ProjectNotFound("No project open".to_string()))?;
    
    let full_path = PathBuf::from(project_path).join(&params.path);
    
    if !full_path.exists() {
        return Err(DbError::ProjectNotFound(params.path));
    }

    let content = fs::read_to_string(&full_path)?;
    let language = detect_language(&params.path);

    Ok(FileContent {
        content,
        path: params.path,
        language,
    })
}

#[derive(Debug, Deserialize)]
pub struct WriteFileParams {
    path: String,
    content: String,
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    params: WriteFileParams,
) -> Result<bool> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| DbError::ProjectNotFound("No project open".to_string()))?;
    
    let full_path = PathBuf::from(project_path).join(&params.path);
    
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(&full_path, &params.content)?;
    Ok(true)
}

#[derive(Debug, Deserialize)]
pub struct DeleteFileParams {
    path: String,
}

#[tauri::command]
pub async fn delete_file(
    state: State<'_, AppState>,
    params: DeleteFileParams,
) -> Result<bool> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| DbError::ProjectNotFound("No project open".to_string()))?;
    
    let full_path = PathBuf::from(project_path).join(&params.path);
    
    if full_path.is_file() {
        fs::remove_file(&full_path)?;
    } else if full_path.is_dir() {
        fs::remove_dir_all(&full_path)?;
    }

    Ok(true)
}

#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    name: String,
    path: String,
    is_directory: bool,
}

#[tauri::command]
pub async fn list_directory(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<Vec<DirectoryEntry>> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| DbError::ProjectNotFound("No project open".to_string()))?;
    
    let full_path = match &path {
        Some(p) => PathBuf::from(project_path).join(p),
        None => PathBuf::from(project_path),
    };

    let mut entries = Vec::new();
    for entry in fs::read_dir(&full_path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        
        if !file_name.starts_with('.') && file_name != ".nightshift" {
            let current_path = path.clone().unwrap_or_default();
            entries.push(DirectoryEntry {
                name: file_name.clone(),
                path: format!("{}/{}", 
                    current_path, 
                    file_name
                ),
                is_directory: metadata.is_dir(),
            });
        }
    }

    Ok(entries)
}

#[tauri::command]
pub async fn watch_files(
    _state: State<'_, AppState>,
    _path: String,
) -> Result<bool> {
    Ok(true)
}

#[derive(Debug, Deserialize)]
pub struct RunInferenceJobParams {
    config: crate::inference::InferenceJobConfig,
}

#[tauri::command]
pub async fn run_inference_job(
    state: State<'_, AppState>,
    params: RunInferenceJobParams,
) -> Result<crate::inference::InferenceJobResult> {
    crate::inference::run_inference_job(state.into_inner(), params.config).await
}

#[derive(Debug, Deserialize)]
pub struct RunJsActionParams {
    config: crate::js_executor::JsActionConfig,
}

#[tauri::command]
pub async fn run_js_action(
    state: State<'_, AppState>,
    params: RunJsActionParams,
) -> Result<crate::js_executor::JsActionResult> {
    crate::js_executor::run_js_action(state.into_inner(), params.config).await
}

#[derive(Debug, Deserialize)]
pub struct CreateCollectionParams {
    name: String,
    schema_json: Option<String>,
}

#[tauri::command]
pub async fn create_collection(
    state: State<'_, AppState>,
    params: CreateCollectionParams,
) -> Result<i64> {
    let project_id = 1;
    
    sqlx::query::<_>(
        r#"
        INSERT INTO collections (project_id, name, schema_json)
        VALUES (?, ?, ?)
        "#,
    )
    .bind(project_id)
    .bind(&params.name)
    .bind(&params.schema_json.unwrap_or_default())
    .execute(state.pool.clone().inner())
    .await?;

    Ok(1)
}

#[tauri::command]
pub async fn get_collection_items(
    state: State<'_, AppState>,
    collection_id: i64,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<serde_json::Value> {
    let page = page.unwrap_or(1);
    let page_size = page_size.unwrap_or(50);
    let offset = (page - 1) * page_size;

    let rows = sqlx::query::<_>(
        r#"
        SELECT id, data_json, created_at
        FROM collection_items
        WHERE collection_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        "#,
    )
    .bind(collection_id)
    .bind(page_size)
    .bind(offset)
    .fetch_all(state.pool.clone().inner())
    .await?;

    let total: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM collection_items WHERE collection_id = ?",
    )
    .bind(collection_id)
    .fetch_one(state.pool.clone().inner())
    .await?;

    let items: Vec<serde_json::Value> = rows.iter().map(|row| {
        serde_json::json!({
            "id": row.get::<i64, _>("id"),
            "data_json": row.get::<String, _>("data_json"),
            "created_at": row.get::<String, _>("created_at"),
        })
    }).collect();

    Ok(serde_json::json!({
        "items": items,
        "total": total.0,
        "page": page,
        "page_size": page_size,
        "total_pages": (total.0 as f64 / page_size as f64).ceil() as i64,
    }))
}

#[derive(Debug, Deserialize)]
pub struct ExportCollectionParams {
    collection_id: i64,
    format: String,
}

#[tauri::command]
pub async fn export_collection(
    state: State<'_, AppState>,
    params: ExportCollectionParams,
) -> Result<String> {
    let rows = sqlx::query::<_>(
        "SELECT data_json FROM collection_items WHERE collection_id = ?",
    )
    .bind(params.collection_id)
    .fetch_all(state.pool.clone().inner())
    .await?;

    match params.format.as_str() {
        "jsonl" => {
            let mut output = String::new();
            for row in rows {
                let data: String = row.get("data_json");
                output.push_str(&data);
                output.push('\n');
            }
            Ok(output)
        }
        "csv" => {
            let mut output = String::new();
            for row in rows {
                let data: String = row.get("data_json");
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) {
                    if let Some(obj) = value.as_object() {
                        let values: Vec<String> = obj.values()
                            .map(|v| v.to_string())
                            .collect();
                        output.push_str(&values.join(","));
                        output.push('\n');
                    }
                }
            }
            Ok(output)
        }
        _ => Err(DbError::JobNotFound(format!("Unknown format: {}", params.format))),
    }
}

#[derive(Debug, Deserialize)]
pub struct SavePipelineParams {
    name: String,
    definition_yaml: String,
}

#[tauri::command]
pub async fn save_pipeline(
    state: State<'_, AppState>,
    params: SavePipelineParams,
) -> Result<i64> {
    crate::pipeline::save_pipeline(state.into_inner(), params.name, params.definition_yaml).await
}

#[derive(Debug, Deserialize)]
pub struct RunPipelineTrialParams {
    definition: crate::pipeline::PipelineDefinition,
    batch_size: usize,
}

#[tauri::command]
pub async fn run_pipeline_trial(
    state: State<'_, AppState>,
    params: RunPipelineTrialParams,
) -> Result<crate::pipeline::PipelineRunResult> {
    crate::pipeline::run_pipeline_trial(state.into_inner(), params.definition, params.batch_size).await
}

#[derive(Debug, Deserialize)]
pub struct RunPipelineParams {
    definition: crate::pipeline::PipelineDefinition,
}

#[tauri::command]
pub async fn run_pipeline(
    state: State<'_, AppState>,
    params: RunPipelineParams,
) -> Result<crate::pipeline::PipelineRunResult> {
    crate::pipeline::run_pipeline(state.into_inner(), params.definition).await
}

#[derive(Debug, Deserialize)]
pub struct DeleteCollectionItemParams {
    collection_id: i64,
    item_id: i64,
}

#[tauri::command]
pub async fn delete_collection_item(
    state: State<'_, AppState>,
    params: DeleteCollectionItemParams,
) -> Result<bool> {
    sqlx::query::<_>(
        r#"
        DELETE FROM collection_items
        WHERE id = ? AND collection_id = ?
        "#,
    )
    .bind(params.item_id)
    .bind(params.collection_id)
    .execute(state.pool.clone().inner())
    .await?;

    Ok(true)
}

#[derive(Debug, Deserialize)]
pub struct RunAnalysisAgentParams {
    config: crate::analysis_agent::AnalysisAgentConfig,
}

#[tauri::command]
pub async fn run_analysis_agent(
    state: State<'_, AppState>,
    params: RunAnalysisAgentParams,
) -> Result<crate::analysis_agent::AnalysisAgentResult> {
    crate::analysis_agent::run_analysis_agent(state.into_inner(), params.config).await
}

#[derive(Debug, Serialize)]
pub struct PipelineRunProgress {
    pub run_id: i64,
    pub current_stage: String,
    pub progress: f64,
    pub status: String,
}

#[tauri::command]
pub async fn get_pipeline_run_progress(
    state: State<'_, AppState>,
    run_id: i64,
) -> Result<Option<PipelineRunProgress>> {
    let row = sqlx::query::<_>(
        r#"
        SELECT 
            id as run_id,
            COALESCE(current_stage, '') as current_stage,
            progress,
            status
        FROM pipeline_runs
        WHERE id = ?
        "#,
    )
    .bind(run_id)
    .fetch_optional(state.pool.clone().inner())
    .await?;

    Ok(row.map(|r| PipelineRunProgress {
        run_id: r.get("run_id"),
        current_stage: r.get("current_stage"),
        progress: r.get("progress"),
        status: r.get("status"),
    }))
}

fn detect_language(path: &str) -> String {
    let ext = Path::new(path).extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    
    match ext {
        "jinja" | "jinja2" | "tpl" => "jinja".to_string(),
        "json" | "jsonl" => "json".to_string(),
        "js" | "jsx" | "ts" | "tsx" => "javascript".to_string(),
        "csv" => "csv".to_string(),
        "yaml" | "yml" => "yaml".to_string(),
        "md" => "markdown".to_string(),
        _ => "plaintext".to_string(),
    }
}
