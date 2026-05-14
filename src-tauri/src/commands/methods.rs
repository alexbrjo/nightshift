use tauri::{AppHandle, State};

use crate::database::DatabaseState;
use crate::methods::{
    CreateMethodDraftInput, ExecutionFileSummary, MethodArtifactSummary, MethodDocument,
    MethodExecutionEventSummary, MethodExecutionNodeSummary, MethodExecutionSummary,
    MethodPreflightResult, MethodSummary, OutputItem, ReplaceMethodDraftGraphInput,
    UpdateMethodDraftExecutionConfigInput, UpdateMethodDraftMetadataInput,
};
use crate::state::MethodExecutionManager;

#[tauri::command]
pub async fn get_current_method_draft(
    db: State<'_, DatabaseState>,
) -> Result<Option<MethodDocument>, String> {
    crate::methods::get_current_method_draft(db).await
}

#[tauri::command]
pub async fn create_method_draft(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: CreateMethodDraftInput,
) -> Result<MethodDocument, String> {
    crate::methods::create_method_draft(app, db, input).await
}

#[tauri::command]
pub async fn update_method_draft_metadata(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: UpdateMethodDraftMetadataInput,
) -> Result<MethodDocument, String> {
    crate::methods::update_method_draft_metadata(app, db, input).await
}

#[tauri::command]
pub async fn update_method_draft_execution_config(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: UpdateMethodDraftExecutionConfigInput,
) -> Result<MethodDocument, String> {
    crate::methods::update_method_draft_execution_config(app, db, input).await
}

#[tauri::command]
pub async fn replace_method_draft_graph(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: ReplaceMethodDraftGraphInput,
) -> Result<MethodDocument, String> {
    crate::methods::replace_method_draft_graph(app, db, input).await
}

#[tauri::command]
pub async fn explain_current_method_draft(db: State<'_, DatabaseState>) -> Result<String, String> {
    crate::methods::explain_current_method_draft(db).await
}

#[tauri::command]
pub async fn reset_method_draft(
    app: AppHandle,
    db: State<'_, DatabaseState>,
) -> Result<Option<MethodDocument>, String> {
    crate::methods::reset_method_draft(app, db).await
}

#[tauri::command]
pub async fn create_method_file(
    db: State<'_, DatabaseState>,
    path: Option<String>,
    input: CreateMethodDraftInput,
) -> Result<MethodDocument, String> {
    crate::methods::create_method_file(db, path, input).await
}

#[tauri::command]
pub async fn get_method_file(
    db: State<'_, DatabaseState>,
    method_path: String,
) -> Result<MethodDocument, String> {
    crate::methods::get_method_file(db, method_path).await
}

#[tauri::command]
pub async fn save_method_file(
    db: State<'_, DatabaseState>,
    method_path: String,
    method: MethodDocument,
) -> Result<MethodSummary, String> {
    crate::methods::save_method_file(db, method_path, method).await
}

#[tauri::command]
pub async fn check_method_completeness(
    db: State<'_, DatabaseState>,
    method_path: String,
) -> Result<MethodPreflightResult, String> {
    crate::methods::check_method_completeness(db, method_path).await
}

#[tauri::command]
pub async fn check_method_document_completeness(
    db: State<'_, DatabaseState>,
    method: MethodDocument,
    base_path: Option<String>,
) -> Result<MethodPreflightResult, String> {
    crate::methods::check_method_document_completeness(db, method, base_path).await
}

#[tauri::command]
pub async fn execute_method_file(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    method_path: String,
) -> Result<MethodExecutionSummary, String> {
    crate::methods::execute_method_file(app, db, manager, method_path).await
}

#[tauri::command]
pub async fn list_method_executions(
    db: State<'_, DatabaseState>,
    method_id: Option<String>,
) -> Result<Vec<MethodExecutionSummary>, String> {
    crate::methods::list_method_executions(db, method_id).await
}

#[tauri::command]
pub async fn get_execution_method(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<MethodDocument, String> {
    crate::methods::get_execution_method(db, execution_id).await
}

#[tauri::command]
pub async fn get_method_execution_nodes(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodExecutionNodeSummary>, String> {
    crate::methods::get_method_execution_nodes(db, execution_id).await
}

#[tauri::command]
pub async fn get_method_execution_events(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodExecutionEventSummary>, String> {
    crate::methods::get_method_execution_events(db, execution_id).await
}

#[tauri::command]
pub async fn get_method_execution_artifacts(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodArtifactSummary>, String> {
    crate::methods::get_method_execution_artifacts(db, execution_id).await
}

#[tauri::command]
pub async fn get_execution_files(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<ExecutionFileSummary>, String> {
    crate::methods::get_execution_files(db, execution_id).await
}

#[tauri::command]
pub async fn get_execution_node_outputs(
    db: State<'_, DatabaseState>,
    execution_id: i64,
    node_id: String,
    page: i32,
    page_size: i32,
) -> Result<Vec<OutputItem>, String> {
    crate::methods::get_execution_node_outputs(db, execution_id, node_id, page, page_size).await
}

#[tauri::command]
pub async fn get_execution_log(
    db: State<'_, DatabaseState>,
    execution_id: i64,
    filter: Option<String>,
    page: i32,
    page_size: i32,
) -> Result<Vec<MethodExecutionEventSummary>, String> {
    crate::methods::get_execution_log(db, execution_id, filter, page, page_size).await
}

#[tauri::command]
pub async fn read_method_artifact(
    db: State<'_, DatabaseState>,
    artifact_id: i64,
) -> Result<String, String> {
    crate::methods::read_method_artifact(db, artifact_id).await
}

#[tauri::command]
pub async fn pause_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    crate::methods::pause_method_execution(db, manager, execution_id).await
}

#[tauri::command]
pub async fn resume_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    crate::methods::resume_method_execution(db, manager, execution_id).await
}

#[tauri::command]
pub async fn cancel_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    crate::methods::cancel_method_execution(db, manager, execution_id).await
}
