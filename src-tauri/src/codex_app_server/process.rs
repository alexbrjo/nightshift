use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use super::audit::{append_agent_audit, audit_app_server_event};
use super::events::{normalize_app_server_event, CodexAppServerEvent};
use crate::methods::{dispatch_method_tool, get_current_draft_for_root};

const CODEX_APP_SERVER_SIDECAR: &str = "codex-app-server";

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

struct JsonRpcResponse {
    result: Result<Value, String>,
}

pub(super) struct CodexAppServerProcess {
    _child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    pub(super) audit_root: Arc<Mutex<Option<PathBuf>>>,
    next_id: u64,
    pub(super) thread_id: Option<String>,
    pub(super) thread_project_root: Option<PathBuf>,
    pub(super) method_tools_registered: bool,
}

impl CodexAppServerProcess {
    pub(super) async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
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

async fn respond_jsonrpc(
    stdin: &Arc<Mutex<ChildStdin>>,
    id: u64,
    result: Result<Value, String>,
) -> Result<(), String> {
    let response = match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32000,
                "message": message
            }
        }),
    };
    write_jsonl(stdin, &response).await
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

pub(super) fn sidecar_filename() -> String {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    format!("{}-{}{}", CODEX_APP_SERVER_SIDECAR, env!("NIGHTSHIFT_TARGET_TRIPLE"), extension)
}

pub(super) fn bundled_app_server_command(app: &AppHandle) -> Result<Vec<String>, String> {
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

pub(super) async fn spawn_app_server_with_command(
    app: AppHandle,
    command_parts: Vec<String>,
    generation: Arc<AtomicU64>,
    process_generation: u64,
) -> Result<CodexAppServerProcess, String> {
    let Some((program, args)) = command_parts.split_first() else {
        return Err("Codex App Server command cannot be empty".into());
    };
    let mut child = Command::new(program)
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start Codex App Server '{}': {}", program, e))?;

    let stdin =
        child.stdin.take().ok_or_else(|| "Failed to open Codex App Server stdin".to_string())?;
    let stdin = Arc::new(Mutex::new(stdin));
    let stdout =
        child.stdout.take().ok_or_else(|| "Failed to open Codex App Server stdout".to_string())?;
    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    let reader_stdin = stdin.clone();
    let audit_root: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let reader_audit_root = audit_root.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            if generation.load(Ordering::SeqCst) != process_generation {
                break;
            }
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if generation.load(Ordering::SeqCst) != process_generation {
                        break;
                    }
                    handle_app_server_line(
                        &app,
                        &reader_pending,
                        &reader_stdin,
                        &reader_audit_root,
                        &line,
                    )
                    .await
                }
                Ok(None) => {
                    if generation.load(Ordering::SeqCst) != process_generation {
                        break;
                    }
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
                            trace_kind: None,
                            tool_name: None,
                            tool_arguments: None,
                            tool_output: None,
                            output_summary: None,
                            duration_ms: None,
                            status: Some("failed".into()),
                            error_message: Some("Codex App Server connection closed".into()),
                            raw: json!({}),
                        },
                    );
                    break;
                }
                Err(error) => {
                    if generation.load(Ordering::SeqCst) != process_generation {
                        break;
                    }
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
                            trace_kind: None,
                            tool_name: None,
                            tool_arguments: None,
                            tool_output: None,
                            output_summary: None,
                            duration_ms: None,
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
        stdin,
        pending,
        audit_root,
        next_id: 0,
        thread_id: None,
        thread_project_root: None,
        method_tools_registered: false,
    };
    process
        .request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "nightshift",
                    "title": "Nightshift",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
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
    stdin: &Arc<Mutex<ChildStdin>>,
    audit_root: &Arc<Mutex<Option<PathBuf>>>,
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
                    trace_kind: None,
                    tool_name: None,
                    tool_arguments: None,
                    tool_output: None,
                    output_summary: None,
                    duration_ms: None,
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

    if let Some(id) = raw.get("id").and_then(Value::as_u64) {
        if raw.get("method").and_then(Value::as_str) == Some("item/tool/call") {
            let root = audit_root.lock().await.clone();
            let result = match root {
                Some(root) => handle_dynamic_method_tool(app, &root, &raw),
                None => Err("No project root is available for Method tool execution".into()),
            };
            let _ = respond_jsonrpc(stdin, id, result).await;
            return;
        }
    }

    if let Some(event) = normalize_app_server_event(&raw) {
        if let Some(root) = audit_root.lock().await.clone() {
            let _ = audit_app_server_event(&root, &event);
        }
        let _ = app.emit("codex-app-server-event", event);
    }
}

fn handle_dynamic_method_tool(app: &AppHandle, root: &Path, raw: &Value) -> Result<Value, String> {
    let params =
        raw.get("params").ok_or_else(|| "Method tool call is missing params".to_string())?;
    let tool = params
        .get("tool")
        .and_then(Value::as_str)
        .ok_or_else(|| "Method tool call is missing tool name".to_string())?;
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let result = dispatch_method_tool(root, tool, arguments)?;
    let _ = app.emit("method-draft-updated", get_current_draft_for_root(root).unwrap_or(None));
    append_agent_audit(
        root,
        json!({
            "kind": "dynamic_method_tool",
            "toolName": tool,
            "toolArguments": params.get("arguments").cloned(),
            "toolOutput": result,
            "status": "completed",
        }),
    )?;
    Ok(json!({
        "contentItems": [{
            "type": "inputText",
            "text": serde_json::to_string_pretty(&result)
                .map_err(|e| format!("Failed to encode Method tool result: {}", e))?
        }],
        "success": true
    }))
}
