mod audit;
mod events;
mod process;

pub use events::normalize_app_server_event;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::methods::method_function_tools;
use audit::{append_agent_audit, AGENT_AUDIT_PATH};
use process::{bundled_app_server_command, spawn_app_server_with_command, CodexAppServerProcess};

const METHOD_DYNAMIC_TOOLS_VERSION: u32 = 2;
const METHOD_AGENT_INSTRUCTIONS: &str =
    include_str!("codex_app_server/method_agent_instructions.md");

const COMMAND_DENY_PATTERNS: &[&str] = &[
    "rm -rf",
    "rm -fr",
    "git reset --hard",
    "git checkout --",
    "git clean",
    "chmod -r",
    "chown -r",
    "curl | sh",
    "curl | bash",
    "curl -s | sh",
    "curl -s | bash",
    "wget | sh",
    "wget | bash",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerSession {
    pub thread_id: String,
    #[serde(default)]
    pub method_tool_config_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnSummary {
    pub thread_id: String,
    pub turn_id: String,
}

pub fn method_agent_turn_input(message: &str) -> String {
    format!("{}\nUser request:\n{}", METHOD_AGENT_INSTRUCTIONS, message.trim())
}

fn security_policy_payload(project_root: &Path) -> Value {
    json!({
        "version": 1,
        "protectedPaths": [".git/**", ".nightshift/**"],
        "readProtectedPaths": true,
        "appManagedAppendOnlyPaths": [AGENT_AUDIT_PATH],
        "denyCommandPatterns": COMMAND_DENY_PATTERNS,
        "denyWritePaths": [".git/**", ".nightshift/**"],
        "requireCanonicalPathContainment": true,
        "denySymlinkEscapes": true,
        "auditLog": AGENT_AUDIT_PATH,
        "networkAccess": false,
        "enforcement": "advisory",
        "threatModel": "Nightshift sends this policy as metadata for Codex App Server turns. Local Nightshift file commands enforce protected app paths separately; Codex App Server command and file-change enforcement is limited to its sandboxPolicy contract.",
        "projectRoot": project_root,
    })
}

fn method_dynamic_tools_config() -> Result<Vec<Value>, String> {
    method_function_tools()
        .into_iter()
        .map(|tool| {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Method tool config is missing a string name: {}", tool))?;
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    format!("Method tool '{}' is missing a string description", name)
                })?;
            Ok(json!({
                "name": name,
                "description": description,
                "inputSchema": tool.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object" })),
            }))
        })
        .collect()
}

fn method_thread_resume_params(thread_id: &str) -> Result<Value, String> {
    Ok(json!({
        "threadId": thread_id,
        "developerInstructions": METHOD_AGENT_INSTRUCTIONS,
        "dynamicTools": method_dynamic_tools_config()?,
    }))
}

fn method_thread_start_params(project_root: &Path) -> Result<Value, String> {
    Ok(json!({
        "cwd": project_root,
        "approvalPolicy": "on-request",
        "dynamicTools": method_dynamic_tools_config()?,
        "developerInstructions": METHOD_AGENT_INSTRUCTIONS,
        "sandbox": "workspace-write",
        "serviceName": "nightshift"
    }))
}

fn method_turn_start_params(
    thread_id: &str,
    project_root: &Path,
    message: String,
    security_policy: Value,
) -> Value {
    json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": message }],
        "cwd": project_root,
        "approvalPolicy": "on-request",
        "sandboxPolicy": {
            "type": "workspaceWrite",
            "writableRoots": [project_root],
            "networkAccess": false
        },
        "nightshiftSecurityPolicy": security_policy,
        "summary": "none"
    })
}

#[derive(Default)]
pub struct CodexAppServerManager {
    process: Mutex<Option<CodexAppServerProcess>>,
    generation: Arc<AtomicU64>,
}

impl CodexAppServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn reset_for_project_switch(&self) {
        let mut process = self.process.lock().await;
        self.generation.fetch_add(1, Ordering::SeqCst);
        *process = None;
    }

    pub async fn ensure_session(
        &self,
        app: AppHandle,
        project_root: &Path,
    ) -> Result<CodexAppServerSession, String> {
        let mut process = self.process.lock().await;
        if process.is_none() {
            let command = bundled_app_server_command(&app)?;
            let process_generation = self.generation.load(Ordering::SeqCst);
            *process = Some(
                spawn_app_server_with_command(
                    app,
                    command,
                    self.generation.clone(),
                    process_generation,
                )
                .await?,
            );
        }
        let process = process.as_mut().expect("process was just initialized");
        *process.audit_root.lock().await = Some(project_root.to_path_buf());
        let canonical_project_root =
            fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        let in_process_thread_matches_root = process
            .thread_project_root
            .as_ref()
            .map(|root| root == &canonical_project_root)
            .unwrap_or(false);
        if let Some(thread_id) = process
            .thread_id
            .clone()
            .filter(|_| process.method_tools_registered && in_process_thread_matches_root)
        {
            let refreshed_thread_id = match process
                .request("thread/resume", method_thread_resume_params(&thread_id)?)
                .await
            {
                Ok(result) => result
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or(&thread_id)
                    .to_string(),
                Err(_) => thread_id.clone(),
            };
            process.thread_id = Some(refreshed_thread_id.clone());
            return Ok(CodexAppServerSession {
                thread_id: refreshed_thread_id,
                method_tool_config_version: Some(METHOD_DYNAMIC_TOOLS_VERSION),
            });
        }

        let stored_thread_id = read_session(project_root)?.map(|session| session.thread_id);
        let thread_id = if let Some(thread_id) = stored_thread_id {
            match process.request("thread/resume", method_thread_resume_params(&thread_id)?).await {
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
            let result =
                process.request("thread/start", method_thread_start_params(project_root)?).await?;
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
        process.thread_project_root = Some(canonical_project_root);
        process.method_tools_registered = true;
        let session = CodexAppServerSession {
            thread_id,
            method_tool_config_version: Some(METHOD_DYNAMIC_TOOLS_VERSION),
        };
        write_session(project_root, &session)?;
        Ok(session)
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
        let security_policy = security_policy_payload(project_root);
        append_agent_audit(
            project_root,
            json!({
                "kind": "turn_requested",
                "threadId": session.thread_id,
                "messageLength": message.len(),
                "securityPolicy": security_policy,
            }),
        )?;
        let result = process
            .request(
                "turn/start",
                method_turn_start_params(
                    &session.thread_id,
                    project_root,
                    message,
                    security_policy,
                ),
            )
            .await?;
        let turn_id = result
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex App Server turn/start returned no turn id".to_string())?
            .to_string();
        append_agent_audit(
            project_root,
            json!({
                "kind": "turn_started",
                "threadId": session.thread_id,
                "turnId": turn_id,
            }),
        )?;
        Ok(CodexTurnSummary { thread_id: session.thread_id, turn_id })
    }
}

fn session_path(project_root: &Path) -> PathBuf {
    project_root.join(".nightshift").join("codex_app_server_session.json")
}

fn read_session(project_root: &Path) -> Result<Option<CodexAppServerSession>, String> {
    let path = session_path(project_root);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read Codex App Server session metadata: {}", e))?;
    let session: CodexAppServerSession = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse Codex App Server session metadata: {}", e))?;
    if session.method_tool_config_version == Some(METHOD_DYNAMIC_TOOLS_VERSION) {
        Ok(Some(session))
    } else {
        Ok(None)
    }
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
    use super::audit::audit_path;
    use super::process::sidecar_filename;
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
    fn normalizes_planning_trace_fields() {
        let event = normalize_app_server_event(&json!({
            "method": "item/toolCall/started",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "itemId": "tool_1",
                "traceKind": "tool",
                "toolName": "replace_method_draft_graph",
                "toolArguments": { "workflow": { "nodes": [] } },
                "toolOutput": { "ok": true },
                "outputSummary": "Draft updated",
                "durationMs": 42
            }
        }))
        .expect("event");

        assert_eq!(event.event_type, "item/toolCall/started");
        assert_eq!(event.trace_kind.as_deref(), Some("tool"));
        assert_eq!(event.tool_name.as_deref(), Some("replace_method_draft_graph"));
        assert_eq!(event.tool_arguments.as_ref().unwrap()["workflow"]["nodes"], json!([]));
        assert_eq!(event.tool_output.as_ref().unwrap()["ok"], true);
        assert_eq!(event.output_summary.as_deref(), Some("Draft updated"));
        assert_eq!(event.duration_ms, Some(42));
    }

    #[test]
    fn normalizes_app_server_command_execution_as_tool_trace() {
        let event = normalize_app_server_event(&json!({
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "id": "cmd_1",
                    "type": "commandExecution",
                    "command": "sed -n '1,80p' methods/current.method.yaml",
                    "cwd": "/tmp/project",
                    "status": "completed",
                    "exitCode": 0,
                    "aggregatedOutput": "schema_version: 2",
                    "durationMs": 12,
                    "commandActions": []
                }
            }
        }))
        .expect("event");

        assert_eq!(event.event_type, "item/toolCall/completed");
        assert_eq!(event.tool_name.as_deref(), Some("exec_command"));
        assert_eq!(
            event.tool_arguments.as_ref().unwrap()["cmd"],
            json!("sed -n '1,80p' methods/current.method.yaml")
        );
        assert_eq!(event.tool_output.as_ref().unwrap()["exitCode"], json!(0));
        assert_eq!(event.output_summary.as_deref(), Some("exit code 0"));
        assert_eq!(event.duration_ms, Some(12));
    }

    #[test]
    fn normalizes_app_server_file_change_as_tool_trace() {
        let event = normalize_app_server_event(&json!({
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "id": "patch_1",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{
                        "path": "methods/current.method.yaml",
                        "kind": { "type": "update", "move_path": null },
                        "diff": "@@"
                    }]
                }
            }
        }))
        .expect("event");

        assert_eq!(event.event_type, "item/toolCall/completed");
        assert_eq!(event.tool_name.as_deref(), Some("apply_patch"));
        assert_eq!(
            event.tool_arguments.as_ref().unwrap()["changes"][0]["path"],
            json!("methods/current.method.yaml")
        );
        assert_eq!(event.output_summary.as_deref(), Some("1 file change"));
    }

    #[test]
    fn normalizes_commentary_agent_message_as_reasoning_trace() {
        let event = normalize_app_server_event(&json!({
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "id": "msg_1",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "I am checking the Method schema."
                }
            }
        }))
        .expect("event");

        assert_eq!(event.event_type, "item/completed");
        assert_eq!(event.trace_kind.as_deref(), Some("reasoning"));
        assert_eq!(event.message_text.as_deref(), Some("I am checking the Method schema."));
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

    #[test]
    fn method_agent_turn_input_includes_security_and_method_guidance() {
        let input = method_agent_turn_input("Build a benchmark");

        assert!(input.contains("normal filesystem and shell tools"));
        assert!(input
            .contains("Do not write, delete, rename, or create files under .git or .nightshift"));
        assert!(input.contains("schema=true"));
        assert!(input.contains("Build a benchmark"));
    }

    #[test]
    fn security_policy_disables_network_and_declares_denied_commands() {
        let policy = security_policy_payload(Path::new("/tmp/project"));

        assert_eq!(policy["networkAccess"].as_bool(), Some(false));
        assert_eq!(policy["enforcement"].as_str(), Some("advisory"));
        assert!(policy["threatModel"].as_str().unwrap().contains("sandboxPolicy"));
        assert!(policy["protectedPaths"].as_array().unwrap().contains(&json!(".git/**")));
        assert_eq!(
            policy["denyWritePaths"].as_array().unwrap(),
            &vec![json!(".git/**"), json!(".nightshift/**")]
        );
        assert!(policy["denyCommandPatterns"].as_array().unwrap().contains(&json!("rm -rf")));
    }

    #[test]
    fn method_dynamic_tools_config_exposes_file_helpers() {
        let tools = method_dynamic_tools_config().unwrap();
        let names = tools
            .iter()
            .map(|tool| tool.get("name").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["create_new_method", "explain_method"]);
        assert_eq!(tools[0]["inputSchema"]["type"].as_str(), Some("object"));
    }

    #[test]
    fn method_thread_start_registers_top_level_dynamic_tools() {
        let start = method_thread_start_params(Path::new("/tmp/project")).unwrap();

        assert!(start.get("dynamicTools").is_some());
        assert!(start.get("dynamic_tools").is_none());
        assert!(start.get("config").is_none());
        assert_eq!(start["dynamicTools"][0]["name"].as_str(), Some("create_new_method"));
    }

    #[test]
    fn method_thread_resume_refreshes_instructions_and_dynamic_tool_config() {
        let resume = method_thread_resume_params("thread_123").unwrap();

        assert_eq!(resume["threadId"].as_str(), Some("thread_123"));
        assert!(resume.get("developerInstructions").is_some());
        assert_eq!(resume["dynamicTools"][0]["name"].as_str(), Some("create_new_method"));
        assert!(resume.get("config").is_none());
    }

    #[test]
    fn method_turn_start_params_do_not_send_unsupported_config() {
        let params = method_turn_start_params(
            "thread_123",
            Path::new("/tmp/project"),
            "hello".into(),
            json!({ "networkAccess": false }),
        );

        assert!(params.get("config").is_none());
        assert_eq!(params["threadId"].as_str(), Some("thread_123"));
        assert_eq!(params["sandboxPolicy"]["networkAccess"].as_bool(), Some(false));
    }

    #[test]
    fn read_session_ignores_legacy_sessions_without_method_tool_version() {
        let project_root =
            std::env::temp_dir().join(format!("nightshift-session-test-{}", std::process::id()));
        let path = session_path(&project_root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        std::fs::write(&path, r#"{"threadId":"legacy_thread"}"#).unwrap();
        assert_eq!(read_session(&project_root).unwrap(), None);

        std::fs::write(
            &path,
            format!(
                r#"{{"threadId":"fresh_thread","methodToolConfigVersion":{}}}"#,
                METHOD_DYNAMIC_TOOLS_VERSION
            ),
        )
        .unwrap();
        let session = read_session(&project_root).unwrap().unwrap();
        assert_eq!(session.thread_id, "fresh_thread");
        assert_eq!(session.method_tool_config_version, Some(METHOD_DYNAMIC_TOOLS_VERSION));

        let _ = std::fs::remove_dir_all(project_root);
    }

    #[test]
    fn agent_audit_log_redacts_secrets_and_appends_under_nightshift() {
        let temp =
            std::env::temp_dir().join(format!("nightshift-agent-audit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();

        append_agent_audit(
            &temp,
            json!({
                "kind": "tool_call",
                "toolArguments": {
                    "api_key": "plain",
                    "value": "sk-test-secret-value"
                }
            }),
        )
        .unwrap();

        let text = fs::read_to_string(audit_path(&temp)).unwrap();
        assert!(text.contains("[redacted]"));
        assert!(!text.contains("sk-test-secret-value"));
        fs::remove_dir_all(temp).ok();
    }
}
