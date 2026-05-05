//! Tauri command handlers for the orchestrator surface. Frontend invokes
//! these via `invoke('definition_create', ...)` etc. Each handler is a thin
//! wrapper over `DefinitionService`; success cases emit one event so the UI
//! can refresh without polling.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::orchestrator::definition_service::{
    DefinitionContent, DefinitionWithVersion, JobDefinition, JobDefinitionVersion,
};
use crate::orchestrator::execution::{ExecutionCollectionItem, JobExecution};
use crate::orchestrator::OrchestratorState;

#[derive(Serialize, Clone)]
struct DefinitionVersionCreatedPayload {
    #[serde(rename = "defId")]
    def_id: i64,
    #[serde(rename = "versionId")]
    version_id: i64,
}

#[derive(Serialize, Clone)]
struct DefinitionUpdatedPayload {
    #[serde(rename = "defId")]
    def_id: i64,
    change: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionCreateInput {
    pub parent_id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub position: i64,
}

#[tauri::command]
pub async fn definition_create(
    state: State<'_, OrchestratorState>,
    input: DefinitionCreateInput,
) -> Result<i64, String> {
    state
        .definition_service
        .create_definition(input.parent_id, input.name, input.position)
        .await
        .map_err(Into::into)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionSaveVersionInput {
    pub def_id: i64,
    pub content: DefinitionContent,
}

#[tauri::command]
pub async fn definition_save_version(
    app: AppHandle,
    state: State<'_, OrchestratorState>,
    input: DefinitionSaveVersionInput,
) -> Result<i64, String> {
    let (version_id, created) = state
        .definition_service
        .save_version(input.def_id, input.content, "user".into(), None)
        .await
        .map_err(String::from)?;
    if created {
        let _ = app.emit(
            "definition-version-created",
            DefinitionVersionCreatedPayload { def_id: input.def_id, version_id },
        );
    }
    Ok(version_id)
}

#[tauri::command]
pub async fn definition_read_current(
    state: State<'_, OrchestratorState>,
    def_id: i64,
) -> Result<DefinitionWithVersion, String> {
    state.definition_service.read_current(def_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn definition_read_version(
    state: State<'_, OrchestratorState>,
    version_id: i64,
) -> Result<JobDefinitionVersion, String> {
    state.definition_service.read_version(version_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn definition_list_versions(
    state: State<'_, OrchestratorState>,
    def_id: i64,
) -> Result<Vec<JobDefinitionVersion>, String> {
    state.definition_service.list_versions(def_id).await.map_err(Into::into)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionRenameInput {
    pub def_id: i64,
    pub new_name: String,
}

#[tauri::command]
pub async fn definition_rename(
    app: AppHandle,
    state: State<'_, OrchestratorState>,
    input: DefinitionRenameInput,
) -> Result<(), String> {
    state.definition_service.rename(input.def_id, input.new_name).await.map_err(String::from)?;
    let _ = app.emit(
        "definition-updated",
        DefinitionUpdatedPayload { def_id: input.def_id, change: "rename" },
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionMoveInput {
    pub def_id: i64,
    pub new_parent_id: Option<i64>,
    #[serde(default)]
    pub new_position: i64,
}

#[tauri::command]
pub async fn definition_move(
    app: AppHandle,
    state: State<'_, OrchestratorState>,
    input: DefinitionMoveInput,
) -> Result<(), String> {
    state
        .definition_service
        .move_(input.def_id, input.new_parent_id, input.new_position)
        .await
        .map_err(String::from)?;
    let _ = app.emit(
        "definition-updated",
        DefinitionUpdatedPayload { def_id: input.def_id, change: "move" },
    );
    Ok(())
}

#[tauri::command]
pub async fn definition_delete(
    app: AppHandle,
    state: State<'_, OrchestratorState>,
    def_id: i64,
) -> Result<(), String> {
    state.definition_service.soft_delete(def_id).await.map_err(String::from)?;
    let _ = app.emit(
        "definition-updated",
        DefinitionUpdatedPayload { def_id, change: "delete" },
    );
    Ok(())
}

#[tauri::command]
pub async fn definition_list_roots(
    state: State<'_, OrchestratorState>,
) -> Result<Vec<JobDefinition>, String> {
    state.definition_service.list_roots().await.map_err(Into::into)
}

#[tauri::command]
pub async fn definition_list_by_root(
    state: State<'_, OrchestratorState>,
    root_id: i64,
) -> Result<Vec<JobDefinition>, String> {
    state.definition_service.list_by_root(root_id).await.map_err(Into::into)
}

// ----- experiment lifecycle -----

#[tauri::command]
pub async fn experiment_start(
    app: AppHandle,
    state: State<'_, OrchestratorState>,
    root_def_id: i64,
) -> Result<i64, String> {
    state.start_run(root_def_id, app).await
}

#[tauri::command]
pub async fn experiment_cancel(
    state: State<'_, OrchestratorState>,
    root_exec_id: i64,
) -> Result<(), String> {
    state.cancel_run(root_exec_id).await
}

// ----- execution reads -----

#[tauri::command]
pub async fn execution_get(
    state: State<'_, OrchestratorState>,
    exec_id: i64,
) -> Result<JobExecution, String> {
    state
        .execution_service
        .get(exec_id)
        .await
        .map_err(|e| format!("failed to read execution: {}", e))?
        .ok_or_else(|| format!("execution {} not found", exec_id))
}

#[tauri::command]
pub async fn execution_get_tree(
    state: State<'_, OrchestratorState>,
    root_exec_id: i64,
) -> Result<Vec<JobExecution>, String> {
    state
        .execution_service
        .get_tree(root_exec_id)
        .await
        .map_err(|e| format!("failed to read execution tree: {}", e))
}

#[tauri::command]
pub async fn execution_get_collection(
    state: State<'_, OrchestratorState>,
    exec_id: i64,
    page: i64,
    page_size: i64,
) -> Result<Vec<ExecutionCollectionItem>, String> {
    let pool = state.execution_service.db.pool();
    let page = page.max(1);
    let page_size = page_size.clamp(1, 500);
    let offset = (page - 1) * page_size;

    let collection_id: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM collection_v2 WHERE execution_id = ?")
            .bind(exec_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("failed to find collection: {}", e))?;

    let Some((cid,)) = collection_id else {
        return Ok(Vec::new());
    };

    sqlx::query_as::<_, ExecutionCollectionItem>(
        "SELECT * FROM collection_item_v2 \
         WHERE collection_id = ? \
         ORDER BY item_index ASC \
         LIMIT ? OFFSET ?",
    )
    .bind(cid)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("failed to read collection items: {}", e))
}

#[tauri::command]
pub async fn execution_get_ledger(
    state: State<'_, OrchestratorState>,
    exec_id: i64,
) -> Result<Option<serde_json::Value>, String> {
    let pool = state.execution_service.db.pool();
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT ledger FROM job_execution WHERE id = ?")
            .bind(exec_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("failed to read ledger: {}", e))?;
    let Some((maybe,)) = row else {
        return Err(format!("execution {} not found", exec_id));
    };
    Ok(maybe
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| format!("invalid ledger JSON: {}", e))?)
}
