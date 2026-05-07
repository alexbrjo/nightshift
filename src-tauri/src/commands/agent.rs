use crate::codex_app_server::{CodexAppServerManager, CodexAppServerSession, CodexTurnSummary};
use crate::database::DatabaseState;
use tauri::{AppHandle, State};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendDesignChatMessageInput {
    pub message: String,
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
    manager: State<'_, CodexAppServerManager>,
) -> Result<CodexAppServerSession, String> {
    let root = project_root(&db)?;
    manager.ensure_session(app, &root).await
}

#[tauri::command]
pub async fn send_design_chat_message(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    manager: State<'_, CodexAppServerManager>,
    input: SendDesignChatMessageInput,
) -> Result<CodexTurnSummary, String> {
    let message = input.message.trim();
    if message.is_empty() {
        return Err("message must not be empty".into());
    }
    let root = project_root(&db)?;
    manager.start_turn(app, &root, message.to_string()).await
}
