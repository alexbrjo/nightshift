use crate::codex_app_server::{CodexAppServerEvent, CodexAppServerSession, CodexTurnSummary};
use crate::database::DatabaseState;
use crate::methods::{dispatch_method_tool, get_current_draft_for_root, method_function_tools};
use crate::utils::secrets::{is_sensitive_key, looks_like_secret_value};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const METHOD_AGENT_MAX_TOOL_LOOPS: usize = 20;
const MAX_TOOL_TRACE_STRING_CHARS: usize = 800;

#[path = "agent_runtime.rs"]
mod runtime;
use runtime::*;

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;

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
    let model = std::env::var("NIGHTSHIFT_METHOD_AGENT_MODEL").unwrap_or_else(|_| "gpt-5.5".into());
    let reasoning_summary =
        if method_agent_reasoning_config(&model).is_some() { "auto" } else { "off" }.to_string();
    Ok(DesignAgentConfig { model, reasoning_summary, max_tool_loops: METHOD_AGENT_MAX_TOOL_LOOPS })
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
    db: State<'_, DatabaseState>,
) -> Result<CodexAppServerSession, String> {
    let root = project_root(&db)?;
    Ok(CodexAppServerSession { thread_id: format!("method-agent-{}", root.to_string_lossy()) })
}

#[tauri::command]
pub async fn send_design_chat_message(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: SendDesignChatMessageInput,
) -> Result<CodexTurnSummary, String> {
    let message = input.message.trim();
    if message.is_empty() {
        return Err("message must not be empty".into());
    }
    let root = project_root(&db)?;
    let thread_id = format!("method-agent-{}", root.to_string_lossy());
    let turn_id = format!("turn-{}", Uuid::new_v4());
    match run_method_agent_turn(&app, &root, &thread_id, &turn_id, message).await {
        Ok(text) => emit_agent_message(&app, &thread_id, &turn_id, &text, "completed", None)?,
        Err(error) => return Err(error),
    }
    Ok(CodexTurnSummary { thread_id, turn_id })
}
