use crate::codex_app_server::{
    method_agent_turn_input, CodexAppServerManager, CodexAppServerSession, CodexTurnSummary,
};
use crate::database::DatabaseState;
use crate::methods::{dispatch_method_tool, get_current_draft_for_root, method_function_tools};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendDesignChatMessageInput {
    pub message: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallMethodAgentFunctionToolInput {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignAgentConfig {
    pub model: String,
    pub reasoning_summary: String,
    pub max_tool_loops: usize,
}

#[tauri::command]
pub async fn get_method_agent_function_tools() -> Result<Vec<Value>, String> {
    Ok(method_function_tools())
}

#[tauri::command]
pub async fn get_design_agent_config() -> Result<DesignAgentConfig, String> {
    Ok(DesignAgentConfig {
        model: "codex-app-server".into(),
        reasoning_summary: "app-server".into(),
        max_tool_loops: 0,
    })
}

#[tauri::command]
pub async fn call_method_agent_function_tool(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: CallMethodAgentFunctionToolInput,
) -> Result<Value, String> {
    let root = project_root(&db)?;
    let result = dispatch_method_tool(&root, &input.name, input.arguments)?;
    emit_current_draft(&app, &root)?;
    Ok(result)
}

fn project_root(db: &DatabaseState) -> Result<std::path::PathBuf, String> {
    let root =
        db.project_root.lock().map_err(|_| "Failed to lock project root".to_string())?.clone();
    if root.as_os_str().is_empty() {
        Err("Open a project folder before starting the Method design agent".into())
    } else {
        Ok(root)
    }
}

#[tauri::command]
pub async fn start_design_session(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    codex: State<'_, CodexAppServerManager>,
) -> Result<CodexAppServerSession, String> {
    let root = project_root(&db)?;
    codex.ensure_session(app, &root).await
}

#[tauri::command]
pub async fn send_design_chat_message(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    codex: State<'_, CodexAppServerManager>,
    input: SendDesignChatMessageInput,
) -> Result<CodexTurnSummary, String> {
    let message = input.message.trim();
    if message.is_empty() {
        return Err("message must not be empty".into());
    }
    let root = project_root(&db)?;
    codex.start_turn(app, &root, method_agent_turn_input(message)).await
}

fn emit_current_draft(app: &AppHandle, root: &std::path::Path) -> Result<(), String> {
    app.emit("method-draft-updated", get_current_draft_for_root(root).unwrap_or(None))
        .map_err(|e| format!("Failed to emit Method draft update: {}", e))
}
