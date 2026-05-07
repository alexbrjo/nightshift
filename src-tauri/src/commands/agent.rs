use crate::codex_app_server::{CodexAppServerEvent, CodexAppServerSession, CodexTurnSummary};
use crate::database::DatabaseState;
use crate::methods::{dispatch_method_tool, get_current_draft_for_root, method_function_tools};
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

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

#[tauri::command]
pub async fn get_method_agent_function_tools() -> Result<Vec<Value>, String> {
    Ok(method_function_tools())
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
    match run_method_agent_turn(&app, &root, message).await {
        Ok(text) => emit_agent_message(&app, &thread_id, &turn_id, &text, "completed", None)?,
        Err(error) => {
            emit_agent_message(&app, &thread_id, &turn_id, &error, "failed", Some(error.clone()))?;
            return Err(error);
        }
    }
    Ok(CodexTurnSummary { thread_id, turn_id })
}

async fn run_method_agent_turn(
    app: &AppHandle,
    root: &std::path::Path,
    message: &str,
) -> Result<String, String> {
    let api_key = std::env::var("OPENAI_API_KEY")
        .or_else(|_| std::env::var("NIGHTSHIFT_OPENAI_API_KEY"))
        .map_err(|_| {
            "Set OPENAI_API_KEY to use the Method design agent function tools.".to_string()
        })?;
    let model = std::env::var("NIGHTSHIFT_METHOD_AGENT_MODEL").unwrap_or_else(|_| "gpt-5.5".into());
    let client = Client::new();
    let tools = method_function_tools();
    let mut body = json!({
        "model": model,
        "instructions": method_agent_instructions(),
        "input": [{ "role": "user", "content": message }],
        "tools": tools
    });

    for _ in 0..5 {
        let response = post_responses_request(&client, &api_key, body).await?;
        let function_calls = response_function_calls(&response)?;
        if function_calls.is_empty() {
            let text =
                response_text(&response).unwrap_or_else(|| "I updated the Method draft.".into());
            emit_current_draft(app, root)?;
            return Ok(text);
        }

        let mut outputs = Vec::new();
        for call in function_calls {
            let result = match serde_json::from_str::<Value>(&call.arguments) {
                Ok(arguments) => match dispatch_method_tool(root, &call.name, arguments) {
                    Ok(value) => {
                        emit_current_draft(app, root)?;
                        json!({ "ok": true, "result": value })
                    }
                    Err(error) => tool_error_output(
                        &call.name,
                        error,
                        "Revise the tool arguments and call the appropriate Method tool again. Do not tell the user the transport failed.",
                    ),
                },
                Err(error) => tool_error_output(
                    &call.name,
                    format!("invalid JSON arguments: {}", error),
                    "Call the tool again with valid JSON arguments.",
                ),
            };
            outputs.push(json!({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": serde_json::to_string(&result)
                    .map_err(|e| format!("Failed to encode tool result: {}", e))?
            }));
        }
        body = json!({
            "model": model,
            "previous_response_id": response.get("id").and_then(Value::as_str)
                .ok_or_else(|| "Responses API returned no response id".to_string())?,
            "input": outputs,
            "tools": tools
        });
    }
    Err("Method agent exceeded the maximum function-call loop depth.".into())
}

fn method_agent_instructions() -> &'static str {
    "You are Nightshift's Method design agent. Use the provided function tools whenever the user describes, creates, or changes a Method. Nightshift owns durable Method draft state; do not pretend a Method is executable while blockers remain. Use App Server native file tools to discover/read candidate project files, then use Nightshift Method tools for durable resource attachment decisions. Prefer creating a concise draft with a DAG of inference, eval, aggregate, and analysis nodes, plus missing prompt, data, JSON schema, eval script, collection, or api_key resources when details are not yet known. Treat prompt, data, JSON schema, and api_key resources as direct inputs to inference nodes unless the user says otherwise; eval_script resources feed eval nodes. Do not create separate analysis nodes merely to sample or stage an input dataset. Aggregate and analysis nodes should usually consume upstream node outputs through graph edges, not raw file resources. API key values may live in .nightshift/config.json, but Method drafts and bundles should reference API key ids rather than copying values. After tool calls, briefly summarize what changed and what is still missing."
}

async fn post_responses_request(
    client: &Client,
    api_key: &str,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to call OpenAI Responses API: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read OpenAI Responses API response: {}", e))?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or(text);
        return Err(format!("OpenAI Responses API returned {}: {}", status, message));
    }
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse OpenAI response: {}", e))
}

#[derive(Debug)]
struct FunctionCall {
    call_id: String,
    name: String,
    arguments: String,
}

fn tool_error_output(name: &str, error: impl ToString, instruction: &str) -> Value {
    json!({
        "ok": false,
        "error": format!("Tool '{}' failed: {}", name, error.to_string()),
        "instruction": instruction
    })
}

fn response_function_calls(response: &Value) -> Result<Vec<FunctionCall>, String> {
    let mut calls = Vec::new();
    for item in response.get("output").and_then(Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        calls.push(FunctionCall {
            call_id: item
                .get("call_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Function call missing call_id".to_string())?
                .to_string(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "Function call missing name".to_string())?
                .to_string(),
            arguments: item
                .get("arguments")
                .and_then(Value::as_str)
                .ok_or_else(|| "Function call missing arguments".to_string())?
                .to_string(),
        });
    }
    Ok(calls)
}

fn response_text(response: &Value) -> Option<String> {
    if let Some(text) = response.get("output_text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    let mut parts = Vec::new();
    for item in response.get("output").and_then(Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        for content in item.get("content").and_then(Value::as_array).into_iter().flatten() {
            if let Some(text) = content
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| content.get("output_text").and_then(Value::as_str))
            {
                parts.push(text.to_string());
            }
        }
    }
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn emit_current_draft(app: &AppHandle, root: &std::path::Path) -> Result<(), String> {
    let draft = get_current_draft_for_root(root)?;
    app.emit("method-draft-updated", draft)
        .map_err(|e| format!("Failed to emit Method draft update: {}", e))
}

fn emit_agent_message(
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    text: &str,
    status: &str,
    error_message: Option<String>,
) -> Result<(), String> {
    app.emit(
        "codex-app-server-event",
        CodexAppServerEvent {
            event_type: "item/completed".into(),
            thread_id: Some(thread_id.into()),
            turn_id: Some(turn_id.into()),
            item_id: Some(format!("assistant-{}", turn_id)),
            text_delta: None,
            message_text: Some(text.into()),
            status: Some(status.into()),
            error_message: error_message.clone(),
            raw: json!({ "source": "nightshift-method-agent", "error": error_message }),
        },
    )
    .map_err(|e| format!("Failed to emit Method agent message: {}", e))?;
    app.emit(
        "codex-app-server-event",
        CodexAppServerEvent {
            event_type: "turn/completed".into(),
            thread_id: Some(thread_id.into()),
            turn_id: Some(turn_id.into()),
            item_id: None,
            text_delta: None,
            message_text: None,
            status: Some(status.into()),
            error_message,
            raw: json!({ "source": "nightshift-method-agent" }),
        },
    )
    .map_err(|e| format!("Failed to emit Method agent turn completion: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_function_calls_from_responses_output() {
        let response = json!({
            "id": "resp_1",
            "output": [{
                "type": "function_call",
                "call_id": "call_1",
                "name": "create_method_draft",
                "arguments": "{\"title\":\"T\",\"objective\":\"O\"}"
            }]
        });

        let calls = response_function_calls(&response).unwrap();

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "create_method_draft");
    }

    #[test]
    fn extracts_message_text_from_responses_output() {
        let response = json!({
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": "Draft created." }]
            }]
        });

        assert_eq!(response_text(&response).unwrap(), "Draft created.");
    }

    #[test]
    fn tool_errors_are_returned_as_repairable_outputs() {
        let output = tool_error_output(
            "replace_method_draft_graph",
            "draft edge starts at unknown node 'sample_verbs'",
            "Revise the tool arguments and call the tool again.",
        );

        assert_eq!(output["ok"], false);
        assert!(output["error"].as_str().unwrap().contains("sample_verbs"));
        assert!(output["instruction"].as_str().unwrap().contains("call the tool again"));
    }
}
