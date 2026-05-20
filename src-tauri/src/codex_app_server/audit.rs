use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::events::CodexAppServerEvent;
use crate::utils::secrets::{is_sensitive_key, looks_like_secret_value};

pub(super) const AGENT_AUDIT_PATH: &str = ".nightshift/agent-audit.jsonl";

pub(super) fn audit_path(project_root: &Path) -> PathBuf {
    project_root.join(AGENT_AUDIT_PATH)
}

pub(super) fn append_agent_audit(project_root: &Path, event: Value) -> Result<(), String> {
    let path = audit_path(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create agent audit directory: {}", e))?;
    }
    let mut line = sanitize_audit_value(&event);
    if let Value::Object(object) = &mut line {
        object.entry("timestamp").or_insert_with(|| {
            json!(std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default())
        });
    }
    let encoded =
        serde_json::to_string(&line).map_err(|e| format!("Failed to encode audit event: {}", e))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open agent audit log: {}", e))?;
    writeln!(file, "{encoded}").map_err(|e| format!("Failed to append agent audit log: {}", e))
}

pub(super) fn audit_app_server_event(
    project_root: &Path,
    event: &CodexAppServerEvent,
) -> Result<(), String> {
    let event_kind = match event.event_type.as_str() {
        event_type if event_type.starts_with("item/toolCall/") => "tool_call",
        "turn/completed" => "turn_completed",
        "item/agentMessage/delta" | "item/completed" => return Ok(()),
        event_type if event_type.contains("reasoningSummary") => return Ok(()),
        _ => "app_server_event",
    };
    append_agent_audit(
        project_root,
        json!({
            "kind": event_kind,
            "eventType": event.event_type,
            "threadId": event.thread_id,
            "turnId": event.turn_id,
            "itemId": event.item_id,
            "toolName": event.tool_name,
            "toolArguments": event.tool_arguments,
            "toolOutput": event.tool_output,
            "status": event.status,
            "errorMessage": event.error_message,
            "durationMs": event.duration_ms,
        }),
    )
}

fn sanitize_audit_value(value: &Value) -> Value {
    sanitize_audit_value_at_depth(value, 0)
}

fn sanitize_audit_value_at_depth(value: &Value, depth: usize) -> Value {
    const MAX_DEPTH: usize = 6;
    const MAX_ARRAY_ITEMS: usize = 24;
    const MAX_OBJECT_KEYS: usize = 64;
    if depth >= MAX_DEPTH {
        return json!("...");
    }
    match value {
        Value::Object(object) => {
            let mut sanitized = serde_json::Map::new();
            for (index, (key, child)) in object.iter().enumerate() {
                if index >= MAX_OBJECT_KEYS {
                    sanitized.insert("...".into(), json!("additional keys omitted"));
                    break;
                }
                if is_sensitive_key(key) {
                    sanitized.insert(key.clone(), json!("[redacted]"));
                } else {
                    sanitized.insert(key.clone(), sanitize_audit_value_at_depth(child, depth + 1));
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(MAX_ARRAY_ITEMS)
                .map(|item| sanitize_audit_value_at_depth(item, depth + 1))
                .collect(),
        ),
        Value::String(text) if looks_like_secret_value(text) => json!("[redacted]"),
        Value::String(text) if text.len() > 1200 => {
            json!(format!("{}...", text.chars().take(1200).collect::<String>()))
        }
        _ => value.clone(),
    }
}
