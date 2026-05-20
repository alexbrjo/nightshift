use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerEvent {
    pub event_type: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub text_delta: Option<String>,
    pub message_text: Option<String>,
    pub trace_kind: Option<String>,
    pub tool_name: Option<String>,
    pub tool_arguments: Option<Value>,
    pub tool_output: Option<Value>,
    pub output_summary: Option<String>,
    pub duration_ms: Option<u128>,
    pub status: Option<String>,
    pub error_message: Option<String>,
    pub raw: Value,
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
    let item_type = item.and_then(|item| item.get("type")).and_then(Value::as_str);
    let message_text = if item_type == Some("agentMessage") {
        item.and_then(|item| item.get("text")).and_then(Value::as_str).map(str::to_string)
    } else {
        None
    };
    let trace_kind = params
        .get("traceKind")
        .and_then(Value::as_str)
        .or_else(|| {
            let phase = item.and_then(|item| item.get("phase")).and_then(Value::as_str);
            (phase == Some("commentary")).then_some("reasoning")
        })
        .map(str::to_string);
    let tool_name = params
        .get("toolName")
        .and_then(Value::as_str)
        .or_else(|| item.and_then(|item| item.get("toolName")).and_then(Value::as_str))
        .or_else(|| item.and_then(|item| item.get("name")).and_then(Value::as_str))
        .or_else(|| tool_name_for_app_server_item(item_type, item))
        .map(str::to_string);
    let tool_arguments = params
        .get("toolArguments")
        .cloned()
        .or_else(|| tool_arguments_for_app_server_item(item_type, item));
    let tool_output = params
        .get("toolOutput")
        .cloned()
        .or_else(|| tool_output_for_app_server_item(item_type, item));
    let output_summary = params
        .get("outputSummary")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| output_summary_for_app_server_item(item_type, item));
    let duration_ms = params
        .get("durationMs")
        .and_then(Value::as_u64)
        .or_else(|| item.and_then(|item| item.get("durationMs")).and_then(Value::as_u64))
        .map(u128::from);
    let status = turn
        .and_then(|turn| turn.get("status"))
        .and_then(Value::as_str)
        .or_else(|| item.and_then(|item| item.get("status")).and_then(Value::as_str))
        .map(normalize_app_server_status);
    let error_message = params
        .get("error")
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .or_else(|| {
            turn.and_then(|turn| turn.get("error"))
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            item.and_then(|item| item.get("error"))
                .and_then(|error| error.get("message").or(Some(error)))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let event_type = match (method.as_str(), item_type) {
        (
            "item/started",
            Some("commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall"),
        ) => "item/toolCall/started".to_string(),
        (
            "item/completed",
            Some("commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall"),
        ) => "item/toolCall/completed".to_string(),
        _ => method,
    };
    Some(CodexAppServerEvent {
        event_type,
        thread_id,
        turn_id,
        item_id,
        text_delta,
        message_text,
        trace_kind,
        tool_name,
        tool_arguments,
        tool_output,
        output_summary,
        duration_ms,
        status,
        error_message,
        raw: raw.clone(),
    })
}

fn normalize_app_server_status(status: &str) -> String {
    match status {
        "inProgress" => "started".to_string(),
        "completed" => "completed".to_string(),
        "failed" => "failed".to_string(),
        other => other.to_string(),
    }
}

fn tool_name_for_app_server_item<'a>(
    item_type: Option<&str>,
    item: Option<&'a Value>,
) -> Option<&'a str> {
    match item_type {
        Some("commandExecution") => Some("exec_command"),
        Some("fileChange") => Some("apply_patch"),
        Some("mcpToolCall" | "dynamicToolCall") => {
            item.and_then(|item| item.get("tool")).and_then(Value::as_str)
        }
        _ => None,
    }
}

fn tool_arguments_for_app_server_item(
    item_type: Option<&str>,
    item: Option<&Value>,
) -> Option<Value> {
    let item = item?;
    match item_type {
        Some("commandExecution") => Some(json!({
            "cmd": item.get("command").cloned().unwrap_or(Value::Null),
            "cwd": item.get("cwd").cloned().unwrap_or(Value::Null),
        })),
        Some("fileChange") => Some(json!({
            "changes": item.get("changes").cloned().unwrap_or_else(|| json!([])),
        })),
        Some("mcpToolCall" | "dynamicToolCall") => item.get("arguments").cloned(),
        _ => None,
    }
}

fn tool_output_for_app_server_item(item_type: Option<&str>, item: Option<&Value>) -> Option<Value> {
    let item = item?;
    match item_type {
        Some("commandExecution") => Some(json!({
            "exitCode": item.get("exitCode").cloned().unwrap_or(Value::Null),
            "output": item.get("aggregatedOutput").cloned().unwrap_or(Value::Null),
        })),
        Some("fileChange") => Some(json!({
            "changes": item.get("changes").cloned().unwrap_or_else(|| json!([])),
        })),
        Some("mcpToolCall") => item.get("result").cloned(),
        Some("dynamicToolCall") => Some(json!({
            "success": item.get("success").cloned().unwrap_or(Value::Null),
            "contentItems": item.get("contentItems").cloned().unwrap_or(Value::Null),
        })),
        _ => None,
    }
}

fn output_summary_for_app_server_item(
    item_type: Option<&str>,
    item: Option<&Value>,
) -> Option<String> {
    let item = item?;
    match item_type {
        Some("commandExecution") => {
            item.get("exitCode").and_then(Value::as_i64).map(|code| format!("exit code {code}"))
        }
        Some("fileChange") => item.get("changes").and_then(Value::as_array).map(|changes| {
            format!("{} file change{}", changes.len(), if changes.len() == 1 { "" } else { "s" })
        }),
        Some("dynamicToolCall") => item.get("success").and_then(Value::as_bool).map(|success| {
            if success {
                "succeeded".into()
            } else {
                "failed".into()
            }
        }),
        _ => None,
    }
}
