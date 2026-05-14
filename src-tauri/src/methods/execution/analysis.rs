use super::*;

const ANALYSIS_SQL_ROW_LIMIT: usize = 200;
const ANALYSIS_MAX_TOOL_LOOPS: usize = 20;
const ANALYSIS_MAX_REPORT_REPAIR_ATTEMPTS: usize = 2;
const ANALYSIS_TOOL_LIST_CONTEXT: &str = "list_analysis_context";
const ANALYSIS_TOOL_RUN_SQL: &str = "run_analysis_sql";
const ANALYSIS_TOOL_READ_ARTIFACT: &str = "read_analysis_artifact";
const ANALYSIS_REPORT_SECTIONS: &[&str] =
    &["Abstract", "Method Summary", "Data Summaries", "Discussion Points", "Caveats", "Conclusion"];

#[derive(Debug)]
struct AnalysisFunctionCall {
    call_id: String,
    name: String,
    arguments: String,
}

pub(crate) fn validate_analysis_sql(sql: &str) -> Result<String, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL query must not be empty".into());
    }
    if trimmed.contains("--") || trimmed.contains("/*") || trimmed.contains("*/") {
        return Err("SQL comments are not allowed in analysis queries".into());
    }
    let without_trailing_semicolon = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if without_trailing_semicolon.contains(';') {
        return Err("Analysis queries must contain exactly one SQL statement".into());
    }
    let tokens = sql_word_tokens(without_trailing_semicolon);
    let Some(first) = tokens.first() else {
        return Err("SQL query must contain a SELECT or WITH statement".into());
    };
    if first != "SELECT" && first != "WITH" {
        return Err("Analysis SQL only allows SELECT or WITH statements".into());
    }
    let forbidden = [
        "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "ATTACH", "DETACH", "PRAGMA", "CREATE",
        "REPLACE", "VACUUM", "TRUNCATE", "BEGIN", "COMMIT", "ROLLBACK",
    ];
    if let Some(token) = tokens.iter().find(|token| forbidden.contains(&token.as_str())) {
        return Err(format!("Analysis SQL cannot use {} statements", token));
    }
    Ok(without_trailing_semicolon.to_string())
}

fn sql_word_tokens(sql: &str) -> Vec<String> {
    sql.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_uppercase())
        .collect()
}

pub(crate) async fn run_analysis_sql_query(
    db: &DatabaseState,
    sql: &str,
    row_limit: usize,
) -> Result<serde_json::Value, String> {
    let normalized = validate_analysis_sql(sql)?;
    let capped_sql = format!("SELECT * FROM ({}) LIMIT {}", normalized, row_limit + 1);
    let rows = sqlx::query(&capped_sql)
        .fetch_all(&db.pool())
        .await
        .map_err(|e| format!("Analysis SQL failed: {}", e))?;
    let truncated = rows.len() > row_limit;
    let mut json_rows = Vec::new();
    for row in rows.iter().take(row_limit) {
        let mut object = serde_json::Map::new();
        for (index, column) in row.columns().iter().enumerate() {
            object.insert(column.name().to_string(), sqlite_cell_to_json(row, index)?);
        }
        json_rows.push(serde_json::Value::Object(object));
    }
    Ok(serde_json::json!({
        "rows": json_rows,
        "row_count": json_rows.len(),
        "truncated": truncated,
        "row_limit": row_limit,
    }))
}

fn sqlite_cell_to_json(
    row: &sqlx::sqlite::SqliteRow,
    index: usize,
) -> Result<serde_json::Value, String> {
    let raw =
        row.try_get_raw(index).map_err(|e| format!("Failed to read SQL result column: {}", e))?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();
    if type_name.contains("INT") {
        if let Ok(value) = row.try_get::<i64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("REAL") || type_name.contains("FLOA") || type_name.contains("DOUB") {
        if let Ok(value) = row.try_get::<f64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("BLOB") {
        if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
            return Ok(serde_json::json!(format!("<{} bytes>", value.len())));
        }
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        if (type_name.contains("JSON") || value.starts_with('{') || value.starts_with('['))
            && serde_json::from_str::<serde_json::Value>(&value).is_ok()
        {
            return serde_json::from_str::<serde_json::Value>(&value)
                .map_err(|e| format!("Failed to decode JSON SQL value: {}", e));
        }
        return Ok(serde_json::json!(value));
    }
    if let Ok(value) = row.try_get::<i64, _>(index) {
        return Ok(serde_json::json!(value));
    }
    if let Ok(value) = row.try_get::<f64, _>(index) {
        return Ok(serde_json::json!(value));
    }
    Ok(serde_json::Value::Null)
}

fn analysis_tools() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "type": "function",
            "name": ANALYSIS_TOOL_LIST_CONTEXT,
            "description": "List the current Method execution context, upstream node outputs, node statuses, files, and useful local SQLite tables for experiment analysis.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            },
            "strict": true
        }),
        serde_json::json!({
            "type": "function",
            "name": ANALYSIS_TOOL_RUN_SQL,
            "description": "Run one read-only SELECT or WITH query against the local Nightshift SQLite database. Useful tables: method_executions, method_execution_nodes, method_execution_events, method_execution_outputs, method_execution_files, inference_jobs, job_outputs, job_failures. Results are capped.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "A single read-only SELECT or WITH statement. Do not include comments or mutating/admin statements."
                    }
                },
                "required": ["sql"],
                "additionalProperties": false
            },
            "strict": true
        }),
        serde_json::json!({
            "type": "function",
            "name": ANALYSIS_TOOL_READ_ARTIFACT,
            "description": "Read inline content for a Method artifact by id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "artifact_id": { "type": "integer" }
                },
                "required": ["artifact_id"],
                "additionalProperties": false
            },
            "strict": true
        }),
    ]
}

async fn analysis_context(
    db: &DatabaseState,
    method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let upstream_outputs = runnable_dependency_ids(method, node)
        .map(|dep| dep.to_string())
        .map(|dep| {
            serde_json::json!({
                "node_id": dep,
                "output_ref": node_outputs.get(&dep),
            })
        })
        .collect::<Vec<_>>();
    let nodes = sqlx::query_as::<_, MethodExecutionNodeSummary>(
        r#"
        SELECT id, execution_id, node_id, node_type, status, output_ref, error_message, started_at, completed_at
        FROM method_execution_nodes
        WHERE execution_id = ?1
        ORDER BY id ASC
        "#,
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to read execution nodes for analysis: {}", e))?;
    let files = sqlx::query_as::<_, MethodArtifactSummary>(
        r#"
        SELECT id, execution_id, node_id, file_type, path, content_hash, created_at
        FROM method_execution_files
        WHERE execution_id = ?1
        ORDER BY id ASC
        "#,
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to read execution files for analysis: {}", e))?;
    Ok(serde_json::json!({
        "execution_id": execution_id,
        "analysis_node_id": node.id,
        "upstream_outputs": upstream_outputs,
        "execution_nodes": nodes,
        "files": files,
        "useful_tables": [
            "method_executions",
            "method_execution_nodes",
            "method_execution_events",
            "method_execution_outputs",
            "method_execution_files",
            "inference_jobs",
            "job_outputs",
            "job_failures"
        ]
    }))
}

async fn dispatch_analysis_tool(
    db: &DatabaseState,
    method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
    name: &str,
    arguments: serde_json::Value,
) -> serde_json::Value {
    let result = match name {
        ANALYSIS_TOOL_LIST_CONTEXT => {
            analysis_context(db, method, execution_id, node, node_outputs).await
        }
        ANALYSIS_TOOL_RUN_SQL => {
            let sql = arguments.get("sql").and_then(serde_json::Value::as_str).unwrap_or("");
            run_analysis_sql_query(db, sql, ANALYSIS_SQL_ROW_LIMIT).await
        }
        ANALYSIS_TOOL_READ_ARTIFACT => {
            let artifact_id = arguments
                .get("artifact_id")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default();
            read_method_artifact_from_db(db, artifact_id).await.map(serde_json::Value::String)
        }
        other => Err(format!("Unknown analysis tool '{}'", other)),
    };
    match result {
        Ok(value) => serde_json::json!({ "ok": true, "result": value }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

fn analysis_agent_instructions() -> String {
    format!(
        "You are Nightshift's experiment analysis agent. Use the provided tools to inspect upstream Method outputs and run read-only SQL before writing the report. The final answer must be Markdown and must include these level-2 headings exactly once, in this order: {}. Cite concrete counts, rates, and artifact/job ids from tool results. If data is missing, incomplete, truncated, or a query/tool fails, describe that under Caveats instead of fabricating results.",
        ANALYSIS_REPORT_SECTIONS
            .iter()
            .map(|section| format!("## {}", section))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

async fn post_analysis_request(
    client: &Client,
    api_key: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to call OpenAI Responses API for analysis: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read analysis agent response: {}", e))?;
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or(text);
        return Err(format!("OpenAI Responses API returned {}: {}", status, message));
    }
    serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse analysis agent response: {}", e))
}

fn analysis_function_calls(
    response: &serde_json::Value,
) -> Result<Vec<AnalysisFunctionCall>, String> {
    let mut calls = Vec::new();
    for item in response.get("output").and_then(serde_json::Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(serde_json::Value::as_str) != Some("function_call") {
            continue;
        }
        calls.push(AnalysisFunctionCall {
            call_id: item
                .get("call_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Analysis function call missing call_id".to_string())?
                .to_string(),
            name: item
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Analysis function call missing name".to_string())?
                .to_string(),
            arguments: item
                .get("arguments")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Analysis function call missing arguments".to_string())?
                .to_string(),
        });
    }
    Ok(calls)
}

fn analysis_response_text(response: &serde_json::Value) -> Option<String> {
    if let Some(text) = response.get("output_text").and_then(serde_json::Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    let mut parts = Vec::new();
    for item in response.get("output").and_then(serde_json::Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(serde_json::Value::as_str) != Some("message") {
            continue;
        }
        for content in
            item.get("content").and_then(serde_json::Value::as_array).into_iter().flatten()
        {
            if let Some(text) = content
                .get("text")
                .and_then(serde_json::Value::as_str)
                .or_else(|| content.get("output_text").and_then(serde_json::Value::as_str))
            {
                parts.push(text.to_string());
            }
        }
    }
    (!parts.is_empty()).then(|| parts.join("\n"))
}

pub(crate) fn validate_analysis_report_sections(report: &str) -> Result<(), String> {
    let mut previous = 0;
    for section in ANALYSIS_REPORT_SECTIONS {
        let heading = format!("## {}", section);
        let Some(index) = report.find(&heading) else {
            return Err(format!("Analysis report is missing required section '{}'", section));
        };
        if index < previous {
            return Err("Analysis report sections are not in the required order".into());
        }
        previous = index;
    }
    Ok(())
}

pub(crate) fn analysis_report_repair_prompt(error: &str, report: &str) -> String {
    format!(
        "The report could not be saved because it failed structural validation: {error}\n\nRewrite the complete report now. Use these exact level-2 Markdown headings, each exactly once and in this order:\n{}\n\nDo not call more tools unless you need missing facts. Preserve any concrete counts and caveats from your prior draft.\n\nPrior draft:\n\n{}",
        ANALYSIS_REPORT_SECTIONS
            .iter()
            .map(|section| format!("## {}", section))
            .collect::<Vec<_>>()
            .join("\n"),
        report
    )
}

pub(crate) async fn insert_analysis_report_artifact(
    db: &DatabaseState,
    method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
    report: &str,
) -> Result<String, String> {
    validate_analysis_report_sections(report)?;
    let storage_ref = write_analysis_report_file(db, method, execution_id, node, report)?;
    insert_artifact(
        db,
        execution_id,
        Some(&node.id),
        "analysis",
        "method_execution_file",
        &storage_ref,
    )
    .await
}

pub(crate) fn analysis_report_relative_path(
    _method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
) -> Result<PathBuf, String> {
    let file_name = node.path.clone().unwrap_or_else(|| format!("{}.md", node.id));
    let file_name = file_name.trim();
    if file_name.is_empty() {
        return Err("analysis report path must not be empty".into());
    }
    let configured = Path::new(file_name);
    if configured.is_absolute() {
        return Err("analysis report path must be relative".into());
    }
    if file_name.contains("..") {
        return Err("analysis report path must stay inside the execution folder".into());
    }
    let mut relative = PathBuf::from(".nightshift")
        .join("executions")
        .join(execution_id.to_string())
        .join("files")
        .join(&node.id)
        .join(configured);
    if relative.extension().is_none() {
        relative.set_extension("md");
    }
    Ok(relative)
}

fn write_analysis_report_file(
    db: &DatabaseState,
    method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
    report: &str,
) -> Result<String, String> {
    let root = project_root(db)?;
    let relative = analysis_report_relative_path(method, execution_id, node)?;
    let path = root.join(&relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!("Failed to create analysis report directory '{}': {}", parent.display(), e)
        })?;
    }
    fs::write(&path, report)
        .map_err(|e| format!("Failed to write analysis report '{}': {}", path.display(), e))?;
    relative
        .to_str()
        .map(|path| path.replace('\\', "/"))
        .ok_or_else(|| "analysis report path must be valid UTF-8".to_string())
}

pub(crate) async fn run_analysis_agent(
    db: &DatabaseState,
    method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let api_key = env::var("OPENAI_API_KEY")
        .or_else(|_| env::var("NIGHTSHIFT_OPENAI_API_KEY"))
        .map_err(|_| {
            "Set OPENAI_API_KEY or NIGHTSHIFT_OPENAI_API_KEY to run the analysis agent.".to_string()
        })?;
    let model = env::var("NIGHTSHIFT_ANALYSIS_AGENT_MODEL")
        .or_else(|_| env::var("NIGHTSHIFT_METHOD_AGENT_MODEL"))
        .unwrap_or_else(|_| "gpt-5.5".into());
    let client = Client::new();
    let tools = analysis_tools();
    let context = analysis_context(db, method, execution_id, node, node_outputs).await?;
    let mut body = serde_json::json!({
        "model": model,
        "instructions": analysis_agent_instructions(),
        "input": [{
            "role": "user",
            "content": format!(
                "Write the experiment report for Method execution {} and analysis node '{}'. Start by calling {} to inspect available context, then run SQL as needed. Initial context: {}",
                execution_id,
                node.id,
                ANALYSIS_TOOL_LIST_CONTEXT,
                context
            )
        }],
        "tools": tools
    });

    let mut tool_call_count = 0usize;
    let mut report_repair_attempts = 0usize;
    for _ in 0..ANALYSIS_MAX_TOOL_LOOPS {
        let response = post_analysis_request(&client, &api_key, body).await?;
        let function_calls = analysis_function_calls(&response)?;
        if function_calls.is_empty() {
            let report = analysis_response_text(&response)
                .ok_or_else(|| "Analysis agent returned no report text".to_string())?;
            return match insert_analysis_report_artifact(db, method, execution_id, node, &report)
                .await
            {
                Ok(output_ref) => Ok(output_ref),
                Err(error) => {
                    if report_repair_attempts < ANALYSIS_MAX_REPORT_REPAIR_ATTEMPTS {
                        report_repair_attempts += 1;
                        body = serde_json::json!({
                            "model": model,
                            "instructions": analysis_agent_instructions(),
                            "previous_response_id": response.get("id").and_then(serde_json::Value::as_str)
                                .ok_or_else(|| "Analysis response missing response id".to_string())?,
                            "input": [{
                                "role": "user",
                                "content": analysis_report_repair_prompt(&error, &report),
                            }],
                            "tools": tools
                        });
                        continue;
                    }
                    Err(format!(
                        "Analysis agent returned report text, but it did not satisfy the required report structure after {} repair attempt(s): {}",
                        ANALYSIS_MAX_REPORT_REPAIR_ATTEMPTS, error
                    ))
                }
            };
        }

        let mut outputs = Vec::new();
        for call in function_calls {
            tool_call_count += 1;
            let result = match serde_json::from_str::<serde_json::Value>(&call.arguments) {
                Ok(arguments) => {
                    dispatch_analysis_tool(
                        db,
                        method,
                        execution_id,
                        node,
                        node_outputs,
                        &call.name,
                        arguments,
                    )
                    .await
                }
                Err(error) => serde_json::json!({
                    "ok": false,
                    "error": format!("Invalid analysis tool JSON arguments: {}", error),
                }),
            };
            outputs.push(serde_json::json!({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": serde_json::to_string(&result)
                    .map_err(|e| format!("Failed to encode analysis tool output: {}", e))?
            }));
        }
        body = serde_json::json!({
            "model": model,
            "instructions": analysis_agent_instructions(),
            "previous_response_id": response.get("id").and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Analysis response missing response id".to_string())?,
            "input": outputs,
            "tools": tools
        });
    }
    Err(format!(
        "Analysis agent exceeded the maximum function-call loop depth after {} tool call(s).",
        tool_call_count
    ))
}
