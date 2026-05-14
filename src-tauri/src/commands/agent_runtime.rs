use super::*;

pub(super) async fn run_method_agent_turn(
    app: &AppHandle,
    root: &std::path::Path,
    thread_id: &str,
    turn_id: &str,
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
    let reasoning = method_agent_reasoning_config(&model);
    let mut body = json!({
        "model": model,
        "instructions": method_agent_instructions(),
        "input": [{ "role": "user", "content": message }],
        "tools": tools
    });
    attach_reasoning_config(&mut body, reasoning.as_ref());

    for response_index in 0..METHOD_AGENT_MAX_TOOL_LOOPS {
        let response = post_responses_request(&client, &api_key, body).await?;
        emit_reasoning_summaries(app, &thread_id, &turn_id, response_index, &response)?;
        let function_calls = response_function_calls(&response)?;
        if function_calls.is_empty() {
            let text =
                response_text(&response).unwrap_or_else(|| "I updated the Method draft.".into());
            emit_current_draft(app, root)?;
            return Ok(text);
        }

        let mut outputs = Vec::new();
        for call in function_calls {
            let parsed_arguments = serde_json::from_str::<Value>(&call.arguments);
            let sanitized_arguments = parsed_arguments.as_ref().ok().map(sanitize_tool_value);
            emit_tool_trace(
                app,
                &thread_id,
                &turn_id,
                &call.call_id,
                &call.name,
                "started",
                ToolTraceDetails {
                    arguments: sanitized_arguments.as_ref(),
                    output: None,
                    output_summary: None,
                    duration_ms: None,
                    error_message: None,
                },
            )?;
            let started_at = Instant::now();
            let result = match parsed_arguments {
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
            let duration_ms = started_at.elapsed().as_millis();
            let sanitized_result = sanitize_tool_value(&result);
            let output_summary = summarize_tool_output(&call.name, &result);
            emit_tool_trace(
                app,
                &thread_id,
                &turn_id,
                &call.call_id,
                &call.name,
                if result.get("ok").and_then(Value::as_bool) == Some(false) {
                    "failed"
                } else {
                    "completed"
                },
                ToolTraceDetails {
                    arguments: sanitized_arguments.as_ref(),
                    output: Some(&sanitized_result),
                    output_summary: output_summary.as_deref(),
                    duration_ms: Some(duration_ms),
                    error_message: result.get("error").and_then(Value::as_str),
                },
            )?;
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
        attach_reasoning_config(&mut body, reasoning.as_ref());
    }
    emit_current_draft(app, root)?;
    Ok("I updated the visible Method draft, but stopped before the design agent produced a final summary because it kept calling tools. Review the draft panel for the current state.".into())
}

pub(super) fn method_agent_instructions() -> &'static str {
    concat!(
        "You are Nightshift's Method design agent. ",
        "Use the provided function tools whenever the user describes, creates, or changes a Method. ",
        "Nightshift owns durable Method draft state; do not pretend a Method is executable while blockers remain. ",
        "You only have Method draft tools in this conversation, so use project-relative file paths the user gives you; ",
        "do not claim to inspect files unless a tool result provided their contents. ",
        "Represent prompt, data, JSON schema, eval script, and api_key inputs as type: resource workflow nodes. ",
        "Use the execution-config tool when the user provides model names, provider settings, temperature, ",
        "token limits, default sample counts, default strategy, or model sweep values. ",
        "Use node config only for settings that must differ by node, such as a judge model, node-specific prompt/data/schema/script resource override, or node-specific sampling behavior. ",
        "Prefer creating a concise draft with a DAG of resource, inference, eval, and analysis nodes when details are not yet known. ",
        "Treat prompt, data, JSON schema, and api_key resource nodes as direct dependencies of inference nodes unless the user says otherwise; ",
        "eval_script resource nodes feed eval nodes. ",
        "Do not create separate analysis nodes merely to sample or stage an input dataset. ",
        "Analysis nodes should consume upstream node outputs through graph edges, not raw file resources, and produce experiment reports from execution results. ",
        "When the user asks to control the report filename/path, put the relative Markdown path in the analysis node's path field. ",
        "API key values may live in .nightshift/config.json, but Method drafts and bundles should reference API key ids rather than copying values. ",
        "After tool calls, briefly summarize what changed and what is still missing. ",
        "Use portable GitHub Flavored Markdown for readability: short paragraphs, bullets only when useful, ",
        "and fenced code blocks only for code, paths, or configuration. Do not use raw HTML."
    )
}

pub(super) fn method_agent_reasoning_config(model: &str) -> Option<Value> {
    let normalized = model.to_ascii_lowercase();
    let supports_reasoning_summary = normalized.starts_with("gpt-5")
        || normalized.starts_with("o1")
        || normalized.starts_with("o3")
        || normalized.starts_with("o4")
        || normalized.contains("reasoning");
    supports_reasoning_summary.then(|| json!({ "summary": "auto" }))
}

fn attach_reasoning_config(body: &mut Value, reasoning: Option<&Value>) {
    if let (Some(object), Some(reasoning)) = (body.as_object_mut(), reasoning) {
        object.insert("reasoning".into(), reasoning.clone());
    }
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
pub(super) struct FunctionCall {
    pub(super) call_id: String,
    pub(super) name: String,
    pub(super) arguments: String,
}

pub(super) fn tool_error_output(name: &str, error: impl ToString, instruction: &str) -> Value {
    json!({
        "ok": false,
        "error": format!("Tool '{}' failed: {}", name, error.to_string()),
        "instruction": instruction
    })
}

pub(super) fn response_function_calls(response: &Value) -> Result<Vec<FunctionCall>, String> {
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

pub(super) fn response_text(response: &Value) -> Option<String> {
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

pub(super) fn response_reasoning_summaries(response: &Value) -> Vec<String> {
    let mut summaries = Vec::new();
    for item in response.get("output").and_then(Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        for summary in item.get("summary").and_then(Value::as_array).into_iter().flatten() {
            if let Some(text) = summary.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    summaries.push(text.trim().to_string());
                }
            }
        }
    }
    summaries
}

pub(super) fn summarize_tool_output(tool_name: &str, output: &Value) -> Option<String> {
    if let Some(error) = output.get("error").and_then(Value::as_str) {
        return Some(format!("Error: {}", truncate_text(error, 180)));
    }
    let result = output.get("result").unwrap_or(output);
    if let Some(explanation) = result.get("explanation").and_then(Value::as_str) {
        return Some(truncate_text(explanation, 220));
    }
    let draft = result.get("draft").or_else(|| output.get("draft"));
    if let Some(draft) = draft {
        let title = draft
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("draft");
        let node_count = draft
            .get("workflow")
            .and_then(|workflow| workflow.get("nodes"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let resource_count = draft
            .get("workflow")
            .and_then(|workflow| workflow.get("nodes"))
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .filter(|node| node.get("type").and_then(Value::as_str) == Some("resource"))
                    .count()
            })
            .unwrap_or_default();
        return Some(format!(
            "Draft '{}' - {} node{} - {} resource{}",
            truncate_text(title, 80),
            node_count,
            if node_count == 1 { "" } else { "s" },
            resource_count,
            if resource_count == 1 { "" } else { "s" },
        ));
    }
    Some(format!("{} returned output", tool_name))
}

pub(super) fn sanitize_tool_value(value: &Value) -> Value {
    sanitize_tool_value_at_depth(value, 0)
}

fn sanitize_tool_value_at_depth(value: &Value, depth: usize) -> Value {
    const MAX_DEPTH: usize = 6;
    const MAX_ARRAY_ITEMS: usize = 20;
    const MAX_OBJECT_KEYS: usize = 60;

    if depth >= MAX_DEPTH {
        return json!("...");
    }

    match value {
        Value::Object(object) => {
            let mut sanitized = serde_json::Map::new();
            for (index, (key, value)) in object.iter().enumerate() {
                if index >= MAX_OBJECT_KEYS {
                    sanitized.insert("...".into(), json!("additional keys omitted"));
                    break;
                }
                if is_sensitive_key(key) {
                    sanitized.insert(key.clone(), json!("[redacted]"));
                } else {
                    sanitized.insert(key.clone(), sanitize_tool_value_at_depth(value, depth + 1));
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => {
            let mut sanitized: Vec<Value> = items
                .iter()
                .take(MAX_ARRAY_ITEMS)
                .map(|item| sanitize_tool_value_at_depth(item, depth + 1))
                .collect();
            if items.len() > MAX_ARRAY_ITEMS {
                sanitized.push(json!("additional items omitted"));
            }
            Value::Array(sanitized)
        }
        Value::String(text) => Value::String(redact_secret_like_string(text)),
        _ => value.clone(),
    }
}

fn redact_secret_like_string(text: &str) -> String {
    if looks_like_secret_value(text) {
        "[redacted]".into()
    } else {
        truncate_text(text, MAX_TOOL_TRACE_STRING_CHARS)
    }
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let mut truncated: String = text.chars().take(max_chars).collect();
    if truncated.len() < text.len() {
        truncated.push_str("...");
    }
    truncated
}

pub(super) fn emit_current_draft(app: &AppHandle, root: &std::path::Path) -> Result<(), String> {
    let draft = get_current_draft_for_root(root)?;
    app.emit("method-draft-updated", draft)
        .map_err(|e| format!("Failed to emit Method draft update: {}", e))
}

fn emit_reasoning_summaries(
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    response_index: usize,
    response: &Value,
) -> Result<(), String> {
    for (index, summary) in response_reasoning_summaries(response).into_iter().enumerate() {
        app.emit(
            "codex-app-server-event",
            CodexAppServerEvent {
                event_type: "item/reasoningSummary/completed".into(),
                thread_id: Some(thread_id.into()),
                turn_id: Some(turn_id.into()),
                item_id: Some(format!("reasoning-{}-{}-{}", turn_id, response_index, index)),
                text_delta: None,
                message_text: Some(summary),
                trace_kind: Some("reasoning".into()),
                tool_name: None,
                tool_arguments: None,
                tool_output: None,
                output_summary: None,
                duration_ms: None,
                status: Some("completed".into()),
                error_message: None,
                raw: json!({ "source": "nightshift-method-agent" }),
            },
        )
        .map_err(|e| format!("Failed to emit Method agent reasoning summary: {}", e))?;
    }
    Ok(())
}

struct ToolTraceDetails<'a> {
    arguments: Option<&'a Value>,
    output: Option<&'a Value>,
    output_summary: Option<&'a str>,
    duration_ms: Option<u128>,
    error_message: Option<&'a str>,
}

fn emit_tool_trace(
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    call_id: &str,
    tool_name: &str,
    status: &str,
    details: ToolTraceDetails<'_>,
) -> Result<(), String> {
    app.emit(
        "codex-app-server-event",
        CodexAppServerEvent {
            event_type: format!("item/toolCall/{}", status),
            thread_id: Some(thread_id.into()),
            turn_id: Some(turn_id.into()),
            item_id: Some(format!("tool-{}-{}", turn_id, call_id)),
            text_delta: None,
            message_text: None,
            trace_kind: Some("tool".into()),
            tool_name: Some(tool_name.into()),
            tool_arguments: details.arguments.cloned(),
            tool_output: details.output.cloned(),
            output_summary: details.output_summary.map(str::to_string),
            duration_ms: details.duration_ms,
            status: Some(status.into()),
            error_message: details.error_message.map(str::to_string),
            raw: json!({ "source": "nightshift-method-agent" }),
        },
    )
    .map_err(|e| format!("Failed to emit Method agent tool trace: {}", e))
}

pub(super) fn emit_agent_message(
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
            trace_kind: None,
            tool_name: None,
            tool_arguments: None,
            tool_output: None,
            output_summary: None,
            duration_ms: None,
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
            trace_kind: None,
            tool_name: None,
            tool_arguments: None,
            tool_output: None,
            output_summary: None,
            duration_ms: None,
            status: Some(status.into()),
            error_message,
            raw: json!({ "source": "nightshift-method-agent" }),
        },
    )
    .map_err(|e| format!("Failed to emit Method agent turn completion: {}", e))
}
