use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const CODEX_APP_SERVER_SIDECAR: &str = "codex-app-server";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerSession {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnSummary {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerEvent {
    pub event_type: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub text_delta: Option<String>,
    pub message_text: Option<String>,
    pub status: Option<String>,
    pub error_message: Option<String>,
    pub raw: Value,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

struct JsonRpcResponse {
    result: Result<Value, String>,
}

pub struct CodexAppServerProcess {
    _child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    next_id: u64,
    thread_id: Option<String>,
}

impl CodexAppServerProcess {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let message = json!({ "id": id, "method": method, "params": params });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        write_jsonl(&self.stdin, &message).await?;
        let response = tokio::time::timeout(Duration::from_secs(120), rx)
            .await
            .map_err(|_| format!("Codex App Server request '{}' timed out", method))?
            .map_err(|_| format!("Codex App Server closed before '{}' completed", method))?;
        response.result
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        write_jsonl(&self.stdin, &json!({ "method": method, "params": params })).await
    }
}

async fn write_jsonl(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().await;
    let mut line = serde_json::to_vec(message)
        .map_err(|e| format!("Failed to encode Codex App Server message: {}", e))?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|e| format!("Failed to write to Codex App Server: {}", e))?;
    stdin.flush().await.map_err(|e| format!("Failed to flush Codex App Server stdin: {}", e))
}

fn command_from_env() -> Option<Vec<String>> {
    if let Ok(json) = std::env::var("NIGHTSHIFT_CODEX_APP_SERVER_COMMAND_JSON") {
        if let Ok(parts) = serde_json::from_str::<Vec<String>>(&json) {
            if !parts.is_empty() {
                return Some(parts);
            }
        }
    }
    std::env::var("NIGHTSHIFT_CODEX_APP_SERVER_BINARY")
        .ok()
        .map(|binary| vec![binary, "app-server".into(), "--listen".into(), "stdio://".into()])
}

fn sidecar_filename() -> String {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    format!("{}-{}{}", CODEX_APP_SERVER_SIDECAR, env!("NIGHTSHIFT_TARGET_TRIPLE"), extension)
}

fn bundled_app_server_command(app: &AppHandle) -> Result<Vec<String>, String> {
    if let Some(command) = command_from_env() {
        return Ok(command);
    }

    let filename = sidecar_filename();
    let resource_path =
        app.path().resource_dir().ok().map(|dir| dir.join(&filename)).filter(|path| path.exists());
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(&filename);
    let sidecar = resource_path
        .or_else(|| dev_path.exists().then_some(dev_path))
        .ok_or_else(|| {
            format!(
                "Bundled Codex App Server sidecar '{}' was not found. Add the platform-specific binary under src-tauri/binaries before building.",
                filename
            )
        })?;

    Ok(vec![
        sidecar.to_string_lossy().into_owned(),
        "app-server".into(),
        "--listen".into(),
        "stdio://".into(),
    ])
}

async fn spawn_app_server_with_command(
    app: AppHandle,
    command_parts: Vec<String>,
) -> Result<CodexAppServerProcess, String> {
    let Some((program, args)) = command_parts.split_first() else {
        return Err("Codex App Server command cannot be empty".into());
    };
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start Codex App Server '{}': {}", program, e))?;

    let stdin =
        child.stdin.take().ok_or_else(|| "Failed to open Codex App Server stdin".to_string())?;
    let stdout =
        child.stdout.take().ok_or_else(|| "Failed to open Codex App Server stdout".to_string())?;
    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => handle_app_server_line(&app, &reader_pending, &line).await,
                Ok(None) => {
                    fail_pending_requests(&reader_pending, "Codex App Server connection closed")
                        .await;
                    let _ = app.emit(
                        "codex-app-server-event",
                        CodexAppServerEvent {
                            event_type: "connection/closed".into(),
                            thread_id: None,
                            turn_id: None,
                            item_id: None,
                            text_delta: None,
                            message_text: None,
                            status: Some("failed".into()),
                            error_message: Some("Codex App Server connection closed".into()),
                            raw: json!({}),
                        },
                    );
                    break;
                }
                Err(error) => {
                    fail_pending_requests(
                        &reader_pending,
                        &format!("Codex App Server connection error: {}", error),
                    )
                    .await;
                    let _ = app.emit(
                        "codex-app-server-event",
                        CodexAppServerEvent {
                            event_type: "connection/error".into(),
                            thread_id: None,
                            turn_id: None,
                            item_id: None,
                            text_delta: None,
                            message_text: None,
                            status: Some("failed".into()),
                            error_message: Some(error.to_string()),
                            raw: json!({}),
                        },
                    );
                    break;
                }
            }
        }
    });

    let mut process = CodexAppServerProcess {
        _child: child,
        stdin: Arc::new(Mutex::new(stdin)),
        pending,
        next_id: 0,
        thread_id: None,
    };
    process
        .request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "nightshift",
                    "title": "Nightshift",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await?;
    process.notify("initialized", json!({})).await?;
    Ok(process)
}

async fn fail_pending_requests(
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    message: &str,
) {
    let mut pending = pending.lock().await;
    for (_, sender) in pending.drain() {
        let _ = sender.send(JsonRpcResponse { result: Err(message.to_string()) });
    }
}

async fn handle_app_server_line(
    app: &AppHandle,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    line: &str,
) {
    let raw: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            let _ = app.emit(
                "codex-app-server-event",
                CodexAppServerEvent {
                    event_type: "protocol/error".into(),
                    thread_id: None,
                    turn_id: None,
                    item_id: None,
                    text_delta: None,
                    message_text: None,
                    status: Some("failed".into()),
                    error_message: Some(format!("Invalid JSON from Codex App Server: {}", error)),
                    raw: json!({ "line": line }),
                },
            );
            return;
        }
    };

    if raw.get("method").is_none() {
        if let Some(id) = raw.get("id").and_then(Value::as_u64) {
            if let Some(sender) = pending.lock().await.remove(&id) {
                let result = if let Some(error) = raw.get("error") {
                    let error = serde_json::from_value::<JsonRpcError>(error.clone())
                        .map(|error| format!("{} ({})", error.message, error.code))
                        .unwrap_or_else(|_| error.to_string());
                    Err(error)
                } else {
                    Ok(raw.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = sender.send(JsonRpcResponse { result });
                return;
            }
        }
    }

    if let Some(event) = normalize_app_server_event(&raw) {
        let _ = app.emit("codex-app-server-event", event);
    }
}

pub fn normalize_app_server_event(raw: &Value) -> Option<CodexAppServerEvent> {
    let method = raw.get("method")?.as_str()?.to_string();
    let params = raw.get("params").cloned().unwrap_or(Value::Null);
    let item = params.get("item");
    let turn = params.get("turn");
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| turn.and_then(|turn| turn.get("threadId")).and_then(Value::as_str))
        .map(str::to_string);
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| turn.and_then(|turn| turn.get("id")).and_then(Value::as_str))
        .map(str::to_string);
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .or_else(|| item.and_then(|item| item.get("id")).and_then(Value::as_str))
        .map(str::to_string);
    let text_delta = params
        .get("delta")
        .and_then(Value::as_str)
        .or_else(|| params.get("text").and_then(Value::as_str))
        .map(str::to_string);
    let message_text =
        item.and_then(|item| item.get("text")).and_then(Value::as_str).map(str::to_string);
    let status = turn
        .and_then(|turn| turn.get("status"))
        .and_then(Value::as_str)
        .or_else(|| item.and_then(|item| item.get("status")).and_then(Value::as_str))
        .map(str::to_string);
    let error_message = params
        .get("error")
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .or_else(|| {
            turn.and_then(|turn| turn.get("error"))
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    Some(CodexAppServerEvent {
        event_type: method,
        thread_id,
        turn_id,
        item_id,
        text_delta,
        message_text,
        status,
        error_message,
        raw: raw.clone(),
    })
}

#[derive(Default)]
pub struct CodexAppServerManager {
    process: Mutex<Option<CodexAppServerProcess>>,
}

impl CodexAppServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn ensure_session(
        &self,
        app: AppHandle,
        project_root: &Path,
    ) -> Result<CodexAppServerSession, String> {
        let mut process = self.process.lock().await;
        if process.is_none() {
            let command = bundled_app_server_command(&app)?;
            *process = Some(spawn_app_server_with_command(app, command).await?);
        }
        let process = process.as_mut().expect("process was just initialized");
        if let Some(thread_id) = &process.thread_id {
            return Ok(CodexAppServerSession { thread_id: thread_id.clone() });
        }

        let stored_thread_id = read_session(project_root)?;
        let thread_id = if let Some(thread_id) = stored_thread_id {
            match process.request("thread/resume", json!({ "threadId": thread_id })).await {
                Ok(result) => result
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                Err(_) => String::new(),
            }
        } else {
            String::new()
        };

        let thread_id = if thread_id.is_empty() {
            let result = process
                .request(
                    "thread/start",
                    json!({
                        "cwd": project_root,
                        "approvalPolicy": "on-request",
                        "sandbox": "workspace-write",
                        "serviceName": "nightshift"
                    }),
                )
                .await?;
            result
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Codex App Server thread/start returned no thread id".to_string())?
                .to_string()
        } else {
            thread_id
        };

        process.thread_id = Some(thread_id.clone());
        write_session(project_root, &CodexAppServerSession { thread_id: thread_id.clone() })?;
        Ok(CodexAppServerSession { thread_id })
    }

    pub async fn start_turn(
        &self,
        app: AppHandle,
        project_root: &Path,
        message: String,
    ) -> Result<CodexTurnSummary, String> {
        let session = self.ensure_session(app, project_root).await?;
        let mut process = self.process.lock().await;
        let process =
            process.as_mut().ok_or_else(|| "Codex App Server is not running".to_string())?;
        let result = process
            .request(
                "turn/start",
                json!({
                    "threadId": session.thread_id,
                    "input": [{ "type": "text", "text": message }],
                    "cwd": project_root,
                    "approvalPolicy": "on-request",
                    "sandboxPolicy": {
                        "type": "workspaceWrite",
                        "writableRoots": [project_root],
                        "networkAccess": false
                    },
                    "summary": "concise"
                }),
            )
            .await?;
        let turn_id = result
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex App Server turn/start returned no turn id".to_string())?
            .to_string();
        Ok(CodexTurnSummary { thread_id: session.thread_id, turn_id })
    }
}

fn session_path(project_root: &Path) -> PathBuf {
    project_root.join(".nightshift").join("codex_app_server_session.json")
}

fn read_session(project_root: &Path) -> Result<Option<String>, String> {
    let path = session_path(project_root);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read Codex App Server session metadata: {}", e))?;
    let session: CodexAppServerSession = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse Codex App Server session metadata: {}", e))?;
    Ok(Some(session.thread_id))
}

fn write_session(project_root: &Path, session: &CodexAppServerSession) -> Result<(), String> {
    let path = session_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Nightshift metadata directory: {}", e))?;
    }
    let text = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Failed to encode Codex App Server session metadata: {}", e))?;
    std::fs::write(path, text)
        .map_err(|e| format!("Failed to persist Codex App Server session metadata: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_agent_message_delta() {
        let event = normalize_app_server_event(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "itemId": "item_1",
                "delta": "hello"
            }
        }))
        .expect("event");

        assert_eq!(event.event_type, "item/agentMessage/delta");
        assert_eq!(event.thread_id.as_deref(), Some("thr_1"));
        assert_eq!(event.turn_id.as_deref(), Some("turn_1"));
        assert_eq!(event.item_id.as_deref(), Some("item_1"));
        assert_eq!(event.text_delta.as_deref(), Some("hello"));
    }

    #[test]
    fn normalizes_failed_turn_error() {
        let event = normalize_app_server_event(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "id": "turn_1",
                    "status": "failed",
                    "error": { "message": "No account" }
                }
            }
        }))
        .expect("event");

        assert_eq!(event.status.as_deref(), Some("failed"));
        assert_eq!(event.error_message.as_deref(), Some("No account"));
    }

    #[test]
    fn sidecar_filename_uses_tauri_external_bin_convention() {
        let filename = sidecar_filename();

        assert!(filename.starts_with("codex-app-server-"));
        assert!(filename.contains(env!("NIGHTSHIFT_TARGET_TRIPLE")));
        if cfg!(windows) {
            assert!(filename.ends_with(".exe"));
        }
    }
}
