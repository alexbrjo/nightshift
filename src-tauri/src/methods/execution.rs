use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use crate::database::DatabaseState;
use crate::job_executor::{JobEvent, JobExecutor, WorkerConfig};
use crate::state::{MethodExecutionControl, MethodExecutionManager};

use super::config::{
    config_f64, config_i32, config_string, method_file_by_kind, model_values,
    resolve_configured_file,
};
use super::model::{
    MethodArtifactSummary, MethodExecutionEventSummary, MethodExecutionNodeSummary,
    MethodExecutionSummary, MethodManifest, MethodWorkflowNode,
};
use super::paths::{method_dir, project_root, validate_method_id};
use super::storage::{hash_directory, hex, read_manifest};
use super::validation::validate_method;

pub(crate) async fn insert_execution(
    db: &DatabaseState,
    method: &MethodManifest,
    content_hash: &str,
) -> Result<i64, String> {
    let result = sqlx::query(
        r#"
        INSERT INTO method_executions (method_id, method_content_hash, status)
        VALUES (?1, ?2, 'queued')
        "#,
    )
    .bind(&method.id)
    .bind(content_hash)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create method execution: {}", e))?;

    let execution_id = result.last_insert_rowid();
    for node in &method.workflow.nodes {
        sqlx::query(
            r#"
            INSERT INTO method_execution_nodes (execution_id, node_id, node_type, status)
            VALUES (?1, ?2, ?3, 'queued')
            "#,
        )
        .bind(execution_id)
        .bind(&node.id)
        .bind(&node.node_type)
        .execute(&db.pool())
        .await
        .map_err(|e| format!("Failed to create method execution node: {}", e))?;
    }
    Ok(execution_id)
}

pub(crate) async fn update_execution_status(
    db: &DatabaseState,
    execution_id: i64,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let completed =
        matches!(status, "completed" | "completed_with_errors" | "failed" | "cancelled");
    sqlx::query(
        r#"
        UPDATE method_executions
        SET status = ?1,
            error_message = ?2,
            started_at = COALESCE(started_at, CASE WHEN ?1 = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END),
            completed_at = CASE WHEN ?3 THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE id = ?4
        "#,
    )
    .bind(status)
    .bind(error)
    .bind(completed)
    .bind(execution_id)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to update method execution: {}", e))?;
    Ok(())
}

pub(crate) async fn update_node_status(
    db: &DatabaseState,
    execution_id: i64,
    node_id: &str,
    status: &str,
    output_ref: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let completed = matches!(status, "completed" | "failed" | "cancelled" | "not_implemented");
    sqlx::query(
        r#"
        UPDATE method_execution_nodes
        SET status = ?1,
            output_ref = COALESCE(?2, output_ref),
            error_message = ?3,
            started_at = COALESCE(started_at, CASE WHEN ?1 = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END),
            completed_at = CASE WHEN ?4 THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE execution_id = ?5 AND node_id = ?6
        "#,
    )
    .bind(status)
    .bind(output_ref)
    .bind(error)
    .bind(completed)
    .bind(execution_id)
    .bind(node_id)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to update method execution node: {}", e))?;
    Ok(())
}

pub(crate) async fn insert_event(
    app: &AppHandle,
    db: &DatabaseState,
    execution_id: i64,
    node_id: Option<&str>,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO method_execution_events (execution_id, node_id, event_type, payload_json)
        VALUES (?1, ?2, ?3, ?4)
        "#,
    )
    .bind(execution_id)
    .bind(node_id)
    .bind(event_type)
    .bind(&payload)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to record method execution event: {}", e))?;

    let _ = app.emit(
        "method-execution-event",
        serde_json::json!({
            "executionId": execution_id,
            "nodeId": node_id,
            "eventType": event_type,
            "payload": payload,
        }),
    );
    Ok(())
}

pub(crate) async fn insert_artifact(
    db: &DatabaseState,
    execution_id: i64,
    node_id: Option<&str>,
    artifact_type: &str,
    storage_kind: &str,
    storage_ref: &str,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(storage_kind.as_bytes());
    hasher.update([0]);
    hasher.update(storage_ref.as_bytes());
    let hash = hex(&hasher.finalize());

    sqlx::query(
        r#"
        INSERT INTO method_artifacts (
            execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
    )
    .bind(execution_id)
    .bind(node_id)
    .bind(artifact_type)
    .bind(storage_kind)
    .bind(storage_ref)
    .bind(&hash)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to record method artifact: {}", e))?;

    Ok(format!("{}:{}", storage_kind, storage_ref))
}

pub(crate) async fn read_method_artifact_from_db(
    db: &DatabaseState,
    artifact_id: i64,
) -> Result<String, String> {
    let artifact = sqlx::query_as::<_, MethodArtifactSummary>(
        r#"
        SELECT id, execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash, created_at
        FROM method_artifacts
        WHERE id = ?1
        "#,
    )
    .bind(artifact_id)
    .fetch_optional(&db.pool())
    .await
    .map_err(|e| format!("Failed to read method artifact: {}", e))?
    .ok_or_else(|| "Method artifact not found".to_string())?;

    match artifact.storage_kind.as_str() {
        "inline_json" | "inline_markdown" => Ok(artifact.storage_ref),
        "inference_job" => Ok(format!("Inference job {}", artifact.storage_ref)),
        "job_set" => Ok(format!("Inference jobs {}", artifact.storage_ref)),
        other => Err(format!("Unsupported method artifact storage kind: {}", other)),
    }
}

pub(crate) fn topological_nodes(
    nodes: &[MethodWorkflowNode],
) -> Result<Vec<MethodWorkflowNode>, String> {
    let mut remaining: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut done = HashSet::new();
    let mut ordered = Vec::new();

    while !remaining.is_empty() {
        let ready_id = remaining
            .values()
            .find(|node| node.depends_on.iter().all(|dep| done.contains(dep.as_str())))
            .map(|node| node.id.clone());
        let Some(id) = ready_id else {
            return Err("method.workflow could not be ordered".into());
        };
        let node = remaining.remove(id.as_str()).expect("ready node exists");
        done.insert(node.id.as_str());
        ordered.push(node.clone());
    }
    Ok(ordered)
}

pub(crate) async fn create_inference_job_for_node(
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
    model_override: Option<&str>,
    name_suffix: Option<&str>,
) -> Result<i64, String> {
    let prompt_file = resolve_configured_file(
        method,
        &method.id,
        config_string(node, method, "prompt_file", None),
        "prompt",
    )?;
    let data_source = resolve_configured_file(
        method,
        &method.id,
        config_string(node, method, "data_source", None),
        "data",
    )?;
    let json_schema_file = if config_string(node, method, "output_mode", Some("Unstructured"))
        .as_deref()
        == Some("JSON Schema")
    {
        Some(resolve_configured_file(
            method,
            &method.id,
            config_string(node, method, "json_schema_file", None),
            "schema",
        )?)
    } else {
        None
    };
    let name = format!(
        "method-{}-{}-{}{}",
        method.id,
        execution_id,
        node.id,
        name_suffix.map(|suffix| format!("-{}", suffix)).unwrap_or_default()
    );
    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, temperature, max_tokens, thinking_budget, samples, strategy,
            json_schema_file, status
        )
        VALUES (
            'inference', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(prompt_file)
    .bind(data_source)
    .bind(config_string(node, method, "provider", Some("Local")).unwrap_or_else(|| "Local".into()))
    .bind(
        model_override
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| config_string(node, method, "model", Some("")).unwrap_or_default()),
    )
    .bind(config_string(node, method, "server_url", Some("")).unwrap_or_default())
    .bind(config_string(node, method, "output_mode", Some("Unstructured")).unwrap())
    .bind(config_f64(node, method, "temperature"))
    .bind(config_i32(node, method, "max_tokens", None))
    .bind(config_i32(node, method, "thinking_budget", None))
    .bind(config_i32(node, method, "samples", Some(1)).unwrap_or(1))
    .bind(config_string(node, method, "strategy", Some("single")).unwrap())
    .bind(json_schema_file)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create inference job for method node '{}': {}", node.id, e))?;
    Ok(result.last_insert_rowid())
}

pub(crate) async fn create_transform_job_for_node(
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
    data_source_override: Option<String>,
    name_suffix: Option<&str>,
) -> Result<i64, String> {
    let data_source = match data_source_override {
        Some(source) => source,
        None => resolve_configured_file(
            method,
            &method.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let script_file = resolve_configured_file(
        method,
        &method.id,
        config_string(node, method, "script_file", None),
        "script",
    )?;
    let name = format!(
        "method-{}-{}-{}{}",
        method.id,
        execution_id,
        node.id,
        name_suffix.map(|suffix| format!("-{}", suffix)).unwrap_or_default()
    );
    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, transform_script_file, transform_error_mode,
            transform_output_mode, status
        )
        VALUES (
            'transform', ?1, '', ?2, 'Nightshift', 'JavaScript', '', 'Transform',
            1, 'exhaustive', ?3, ?4, ?5, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(data_source)
    .bind(script_file)
    .bind(config_string(node, method, "error_mode", Some("stop")).unwrap())
    .bind(config_string(node, method, "output_mode", Some("one_to_one")).unwrap())
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create transform job for method node '{}': {}", node.id, e))?;
    Ok(result.last_insert_rowid())
}

pub(crate) async fn collection_ref_for_job(
    db: &DatabaseState,
    job_id: i64,
) -> Result<String, String> {
    let collection_id: i64 = sqlx::query_scalar("SELECT id FROM collections WHERE job_id = ?1")
        .bind(job_id)
        .fetch_one(&db.pool())
        .await
        .map_err(|e| format!("Failed to find output collection for job {}: {}", job_id, e))?;
    Ok(format!("collection:{}", collection_id))
}

pub(crate) fn parse_job_ids(output_ref: &str) -> Result<Vec<i64>, String> {
    if let Some(job_id) = output_ref.strip_prefix("inference_job:") {
        return job_id
            .parse::<i64>()
            .map(|id| vec![id])
            .map_err(|_| format!("Invalid job ref '{}'", output_ref));
    }
    if let Some(ids) = output_ref.strip_prefix("job_set:") {
        return ids
            .split(',')
            .filter(|id| !id.trim().is_empty())
            .map(|id| {
                id.parse::<i64>().map_err(|_| format!("Invalid job set ref '{}'", output_ref))
            })
            .collect();
    }
    Ok(vec![])
}

pub(crate) async fn upstream_collection_source(
    db: &DatabaseState,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(dep) = node.depends_on.first() else {
        return Ok(None);
    };
    let Some(output_ref) = node_outputs.get(dep) else {
        return Ok(None);
    };
    let job_ids = parse_job_ids(output_ref)?;
    if let Some(job_id) = job_ids.first() {
        return collection_ref_for_job(db, *job_id).await.map(Some);
    }
    Ok(None)
}

pub(crate) async fn upstream_job_sources(
    db: &DatabaseState,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Vec<(i64, String)>, String> {
    let Some(dep) = node.depends_on.first() else {
        return Ok(vec![]);
    };
    let Some(output_ref) = node_outputs.get(dep) else {
        return Ok(vec![]);
    };
    let mut sources = Vec::new();
    for job_id in parse_job_ids(output_ref)? {
        sources.push((job_id, collection_ref_for_job(db, job_id).await?));
    }
    Ok(sources)
}

pub(crate) async fn run_job_agent(
    app: &AppHandle,
    db: &DatabaseState,
    execution_id: i64,
    node_id: &str,
    job_id: i64,
) -> Result<String, String> {
    let executor = JobExecutor::from_database(db.clone())?;
    executor.start_job(job_id).await?;
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id)
        .await?
        .ok_or("Method agent job not found")?;
    let config = WorkerConfig::from_job(job);
    let (tx, mut rx) = mpsc::channel::<JobEvent>(100);
    let exec_clone = executor.clone();
    let handle = tokio::spawn(async move { exec_clone.execute_job(config, tx).await });

    let mut final_error = None;
    let mut final_status = "completed".to_string();
    while let Some(event) = rx.recv().await {
        match &event {
            JobEvent::Completed { failure_count, .. } => {
                final_status = if *failure_count > 0 {
                    "completed_with_errors".into()
                } else {
                    "completed".into()
                };
            }
            JobEvent::Failed { error, .. } => {
                final_status = "failed".into();
                final_error = Some(error.clone());
            }
            JobEvent::Cancelled { .. } => {
                final_status = "cancelled".into();
            }
            _ => {}
        }
        insert_event(
            app,
            db,
            execution_id,
            Some(node_id),
            "node_job_event",
            serde_json::to_value(event).unwrap_or_else(|_| serde_json::json!({})),
        )
        .await?;
    }
    handle.await.map_err(|e| format!("Method agent task failed: {}", e))??;

    match final_status.as_str() {
        "completed" => {
            crate::database::update_job_status(&db.pool(), job_id, "completed").await?;
        }
        "completed_with_errors" => {
            crate::database::update_job_status(&db.pool(), job_id, "completed_with_errors").await?;
        }
        "cancelled" => {
            crate::database::update_job_status(&db.pool(), job_id, "cancelled").await?;
            return Err("Agent job was cancelled".into());
        }
        _ => {
            let error = final_error.unwrap_or_else(|| "Agent job failed".into());
            crate::database::update_job_status_with_error(&db.pool(), job_id, &error).await?;
            return Err(error);
        }
    }
    insert_artifact(db, execution_id, Some(node_id), "job", "inference_job", &job_id.to_string())
        .await
}

pub(crate) async fn run_inference_agent(
    app: &AppHandle,
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
) -> Result<String, String> {
    let models = model_values(method);
    if models.len() <= 1 {
        let model_name = models
            .first()
            .cloned()
            .or_else(|| config_string(node, method, "model", Some("")))
            .unwrap_or_default();
        let job_id = create_inference_job_for_node(
            db,
            method,
            node,
            execution_id,
            models.first().map(String::as_str),
            None,
        )
        .await?;
        insert_event(
            app,
            db,
            execution_id,
            Some(&node.id),
            "inference_job_created",
            serde_json::json!({
                "jobId": job_id,
                "model": model_name,
                "samples": config_i32(node, method, "samples", Some(1)).unwrap_or(1),
            }),
        )
        .await?;
        return run_job_agent(app, db, execution_id, &node.id, job_id).await;
    }

    let mut job_ids = Vec::new();
    for model in models {
        insert_event(
            app,
            db,
            execution_id,
            Some(&node.id),
            "sweep_model_started",
            serde_json::json!({ "model": model }),
        )
        .await?;
        let job_id = create_inference_job_for_node(
            db,
            method,
            node,
            execution_id,
            Some(&model),
            Some(&slug_for_ref(&model)),
        )
        .await?;
        insert_event(
            app,
            db,
            execution_id,
            Some(&node.id),
            "inference_job_created",
            serde_json::json!({
                "jobId": job_id,
                "model": model,
                "samples": config_i32(node, method, "samples", Some(1)).unwrap_or(1),
            }),
        )
        .await?;
        run_job_agent(app, db, execution_id, &node.id, job_id).await?;
        job_ids.push(job_id);
    }
    let storage_ref = job_ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
    insert_artifact(db, execution_id, Some(&node.id), "job_set", "job_set", &storage_ref).await?;
    Ok(format!("job_set:{}", storage_ref))
}

pub(crate) fn slug_for_ref(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase()
}

pub(crate) async fn run_transform_agent(
    app: &AppHandle,
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let upstream_sources = upstream_job_sources(db, node, node_outputs).await?;
    if upstream_sources.is_empty() {
        let upstream_source = upstream_collection_source(db, node, node_outputs).await?;
        let job_id =
            create_transform_job_for_node(db, method, node, execution_id, upstream_source, None)
                .await?;
        return run_job_agent(app, db, execution_id, &node.id, job_id).await;
    }

    let mut job_ids = Vec::new();
    for (source_job_id, source) in upstream_sources {
        let job_id = create_transform_job_for_node(
            db,
            method,
            node,
            execution_id,
            Some(source),
            Some(&format!("from-{}", source_job_id)),
        )
        .await?;
        run_job_agent(app, db, execution_id, &node.id, job_id).await?;
        job_ids.push(job_id);
    }
    let storage_ref = job_ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
    insert_artifact(db, execution_id, Some(&node.id), "job_set", "job_set", &storage_ref).await?;
    Ok(format!("job_set:{}", storage_ref))
}

pub(crate) async fn collection_items_for_job(
    db: &DatabaseState,
    job_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let collection_id: i64 = sqlx::query_scalar("SELECT id FROM collections WHERE job_id = ?1")
        .bind(job_id)
        .fetch_one(&db.pool())
        .await
        .map_err(|e| format!("Failed to find collection for job {}: {}", job_id, e))?;
    sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT data FROM collection_items WHERE collection_id = ?1 ORDER BY id ASC",
    )
    .bind(collection_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to read collection items: {}", e))
}

pub(crate) async fn job_model(db: &DatabaseState, job_id: i64) -> Result<String, String> {
    sqlx::query_scalar::<_, String>("SELECT model FROM inference_jobs WHERE id = ?1")
        .bind(job_id)
        .fetch_one(&db.pool())
        .await
        .map_err(|e| format!("Failed to read job model: {}", e))
}

pub(crate) fn item_passed(item: &serde_json::Value) -> Option<bool> {
    let obj = item.as_object()?;
    for key in ["pass", "passed", "success", "correct"] {
        if let Some(value) = obj.get(key).and_then(|value| value.as_bool()) {
            return Some(value);
        }
    }
    None
}

pub(crate) async fn run_aggregate_agent(
    db: &DatabaseState,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let Some(dep) = node.depends_on.first() else {
        return Err("Aggregate node needs an upstream dependency".into());
    };
    let output_ref = node_outputs
        .get(dep)
        .ok_or_else(|| format!("Aggregate dependency '{}' has no output", dep))?;
    let job_ids = parse_job_ids(output_ref)?;
    let mut groups = serde_json::Map::new();
    for job_id in job_ids {
        let model = job_model(db, job_id).await.unwrap_or_else(|_| format!("job-{}", job_id));
        let items = collection_items_for_job(db, job_id).await?;
        let total = items.len();
        let scored = items.iter().filter_map(item_passed).collect::<Vec<_>>();
        let passed = scored.iter().filter(|value| **value).count();
        let success_rate = if scored.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!(passed as f64 / scored.len() as f64)
        };
        groups.insert(
            model,
            serde_json::json!({
                "job_id": job_id,
                "total_items": total,
                "scored_items": scored.len(),
                "passed": passed,
                "success_rate": success_rate,
            }),
        );
    }
    let aggregate = serde_json::json!({
        "source": output_ref,
        "groups": groups,
    });
    let storage_ref = serde_json::to_string_pretty(&aggregate)
        .map_err(|e| format!("Failed to serialize aggregate: {}", e))?;
    insert_artifact(db, execution_id, Some(&node.id), "aggregate", "inline_json", &storage_ref)
        .await
}

pub(crate) async fn run_analysis_agent(
    db: &DatabaseState,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let mut body = String::from("# Analysis Draft\n\n");
    if let Some(dep) = node.depends_on.first().and_then(|dep| node_outputs.get(dep)) {
        body.push_str("This draft was generated from the Method execution artifacts.\n\n");
        body.push_str("## Source\n\n");
        body.push_str(dep);
        body.push_str("\n\n");
        if let Some(json) = dep.strip_prefix("inline_json:") {
            body.push_str("## Aggregate\n\n```json\n");
            body.push_str(json);
            body.push_str("\n```\n");
        }
    } else {
        body.push_str("No upstream aggregate artifact was available.\n");
    }
    insert_artifact(db, execution_id, Some(&node.id), "analysis", "inline_markdown", &body).await
}

pub(crate) async fn run_not_implemented_agent(
    db: &DatabaseState,
    execution_id: i64,
    node: &MethodWorkflowNode,
) -> Result<String, String> {
    insert_artifact(
        db,
        execution_id,
        Some(&node.id),
        "not_implemented",
        "inline",
        &format!(
            "{} agent is not implemented yet. The node was recorded with scoped status for this execution.",
            node.node_type
        ),
    )
    .await
}

pub(crate) async fn wait_if_paused(
    app: &AppHandle,
    db: &DatabaseState,
    execution_id: i64,
    control: &MethodExecutionControl,
) -> Result<(), String> {
    let mut emitted = false;
    while control.pause_requested.load(Ordering::SeqCst) {
        if control.cancel_requested.load(Ordering::SeqCst) {
            return Err("Execution cancelled".into());
        }
        if !emitted {
            update_execution_status(db, execution_id, "paused", None).await?;
            insert_event(app, db, execution_id, None, "execution_paused", serde_json::json!({}))
                .await?;
            emitted = true;
        }
        sleep(Duration::from_millis(250)).await;
    }
    if emitted {
        update_execution_status(db, execution_id, "running", None).await?;
        insert_event(app, db, execution_id, None, "execution_resumed", serde_json::json!({}))
            .await?;
    }
    Ok(())
}

pub(crate) async fn orchestrate_method_execution(
    app: AppHandle,
    db: DatabaseState,
    execution_id: i64,
    method: MethodManifest,
    control: MethodExecutionControl,
) -> Result<(), String> {
    update_execution_status(&db, execution_id, "running", None).await?;
    insert_event(
        &app,
        &db,
        execution_id,
        None,
        "execution_started",
        serde_json::json!({ "methodId": method.id }),
    )
    .await?;

    let mut had_not_implemented = false;
    let mut node_outputs: HashMap<String, String> = HashMap::new();
    for node in topological_nodes(&method.workflow.nodes)? {
        wait_if_paused(&app, &db, execution_id, &control).await?;
        if control.cancel_requested.load(Ordering::SeqCst) {
            update_node_status(&db, execution_id, &node.id, "cancelled", None, None).await?;
            update_execution_status(&db, execution_id, "cancelled", None).await?;
            insert_event(
                &app,
                &db,
                execution_id,
                Some(&node.id),
                "execution_cancelled",
                serde_json::json!({}),
            )
            .await?;
            return Ok(());
        }
        update_node_status(&db, execution_id, &node.id, "running", None, None).await?;
        insert_event(
            &app,
            &db,
            execution_id,
            Some(&node.id),
            "node_started",
            serde_json::json!({ "nodeType": node.node_type }),
        )
        .await?;

        let result = match node.node_type.as_str() {
            "inference" => run_inference_agent(&app, &db, &method, &node, execution_id).await,
            "transform" => {
                run_transform_agent(&app, &db, &method, &node, execution_id, &node_outputs).await
            }
            "eval"
                if method_file_by_kind(&method, "script").is_some()
                    || config_string(&node, &method, "script_file", None).is_some() =>
            {
                run_transform_agent(&app, &db, &method, &node, execution_id, &node_outputs).await
            }
            "aggregate" => run_aggregate_agent(&db, execution_id, &node, &node_outputs).await,
            "analysis" => run_analysis_agent(&db, execution_id, &node, &node_outputs).await,
            "eval" => {
                had_not_implemented = true;
                let artifact = run_not_implemented_agent(&db, execution_id, &node).await?;
                update_node_status(
                    &db,
                    execution_id,
                    &node.id,
                    "not_implemented",
                    Some(&artifact),
                    Some("Agent implementation is not available yet"),
                )
                .await?;
                insert_event(
                    &app,
                    &db,
                    execution_id,
                    Some(&node.id),
                    "node_not_implemented",
                    serde_json::json!({ "nodeType": node.node_type, "artifact": artifact }),
                )
                .await?;
                continue;
            }
            other => Err(format!("Unknown method node type '{}'", other)),
        };

        match result {
            Ok(output_ref) => {
                node_outputs.insert(node.id.clone(), output_ref.clone());
                update_node_status(
                    &db,
                    execution_id,
                    &node.id,
                    "completed",
                    Some(&output_ref),
                    None,
                )
                .await?;
                insert_event(
                    &app,
                    &db,
                    execution_id,
                    Some(&node.id),
                    "node_completed",
                    serde_json::json!({ "outputRef": output_ref }),
                )
                .await?;
            }
            Err(e) => {
                update_node_status(&db, execution_id, &node.id, "failed", None, Some(&e)).await?;
                update_execution_status(&db, execution_id, "failed", Some(&e)).await?;
                insert_event(
                    &app,
                    &db,
                    execution_id,
                    Some(&node.id),
                    "node_failed",
                    serde_json::json!({ "error": e }),
                )
                .await?;
                return Ok(());
            }
        }
    }

    let status = if had_not_implemented { "completed_with_errors" } else { "completed" };
    update_execution_status(&db, execution_id, status, None).await?;
    insert_event(
        &app,
        &db,
        execution_id,
        None,
        "execution_completed",
        serde_json::json!({ "status": status }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn execute_method(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    id: String,
) -> Result<i64, String> {
    validate_method_id(&id)?;
    let root = project_root(&db)?;
    let folder = method_dir(&root, &id);
    let method = read_manifest(&folder)?;
    validate_method(&method)?;
    let content_hash = hash_directory(&folder)?;
    let execution_id = insert_execution(&db, &method, &content_hash).await?;
    let control = MethodExecutionControl::new();
    manager.controls.lock().await.insert(execution_id, control.clone());

    let app_handle = app.clone();
    let db_state = (*db).clone();
    let manager_state = manager.inner().controls.clone();
    tokio::spawn(async move {
        if let Err(e) = orchestrate_method_execution(
            app_handle.clone(),
            db_state.clone(),
            execution_id,
            method,
            control,
        )
        .await
        {
            let _ = update_execution_status(&db_state, execution_id, "failed", Some(&e)).await;
            let _ = insert_event(
                &app_handle,
                &db_state,
                execution_id,
                None,
                "execution_failed",
                serde_json::json!({ "error": e }),
            )
            .await;
        }
        manager_state.lock().await.remove(&execution_id);
    });

    Ok(execution_id)
}

#[tauri::command]
pub async fn list_method_executions(
    db: State<'_, DatabaseState>,
    method_id: Option<String>,
) -> Result<Vec<MethodExecutionSummary>, String> {
    if let Some(id) = method_id {
        sqlx::query_as::<_, MethodExecutionSummary>(
            r#"
            SELECT id, method_id, method_content_hash, status, error_message, created_at, started_at, completed_at
            FROM method_executions
            WHERE method_id = ?1
            ORDER BY created_at DESC
            "#,
        )
        .bind(id)
        .fetch_all(&db.pool())
        .await
        .map_err(|e| format!("Failed to list method executions: {}", e))
    } else {
        sqlx::query_as::<_, MethodExecutionSummary>(
            r#"
            SELECT id, method_id, method_content_hash, status, error_message, created_at, started_at, completed_at
            FROM method_executions
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&db.pool())
        .await
        .map_err(|e| format!("Failed to list method executions: {}", e))
    }
}

#[tauri::command]
pub async fn get_method_execution_nodes(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodExecutionNodeSummary>, String> {
    sqlx::query_as::<_, MethodExecutionNodeSummary>(
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
    .map_err(|e| format!("Failed to list method execution nodes: {}", e))
}

#[tauri::command]
pub async fn get_method_execution_events(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodExecutionEventSummary>, String> {
    sqlx::query_as::<_, MethodExecutionEventSummary>(
        r#"
        SELECT id, execution_id, node_id, event_type, payload_json, created_at
        FROM method_execution_events
        WHERE execution_id = ?1
        ORDER BY id ASC
        "#,
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list method execution events: {}", e))
}

#[tauri::command]
pub async fn get_method_execution_artifacts(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodArtifactSummary>, String> {
    sqlx::query_as::<_, MethodArtifactSummary>(
        r#"
        SELECT id, execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash, created_at
        FROM method_artifacts
        WHERE execution_id = ?1
        ORDER BY id ASC
        "#,
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list method execution artifacts: {}", e))
}

#[tauri::command]
pub async fn read_method_artifact(
    db: State<'_, DatabaseState>,
    artifact_id: i64,
) -> Result<String, String> {
    read_method_artifact_from_db(&db, artifact_id).await
}

#[tauri::command]
pub async fn pause_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    if let Some(control) = manager.controls.lock().await.get(&execution_id) {
        control.pause_requested.store(true, Ordering::SeqCst);
        update_execution_status(&db, execution_id, "pause_requested", None).await?;
        Ok(())
    } else {
        Err("Method execution is not active".into())
    }
}

#[tauri::command]
pub async fn resume_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    if let Some(control) = manager.controls.lock().await.get(&execution_id) {
        control.pause_requested.store(false, Ordering::SeqCst);
        update_execution_status(&db, execution_id, "running", None).await?;
        Ok(())
    } else {
        Err("Method execution is not active".into())
    }
}

#[tauri::command]
pub async fn cancel_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    if let Some(control) = manager.controls.lock().await.get(&execution_id) {
        control.cancel_requested.store(true, Ordering::SeqCst);
        update_execution_status(&db, execution_id, "cancel_requested", None).await?;
        Ok(())
    } else {
        update_execution_status(&db, execution_id, "cancelled", None).await
    }
}
