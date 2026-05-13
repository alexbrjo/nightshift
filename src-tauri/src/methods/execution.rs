use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use reqwest::Client;
use sha2::{Digest, Sha256};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use crate::database::DatabaseState;
use crate::job_executor::{JobEvent, JobExecutor, WorkerConfig};
use crate::state::{MethodExecutionControl, MethodExecutionManager};

use super::config::{
    config_f64, config_i32, config_string, method_file_by_kind, model_values,
    resolve_configured_file, runnable_dependency_ids, runnable_nodes, yaml_lookup, yaml_string,
};
use super::model::{
    MethodArtifactSummary, MethodDocument, MethodExecutionEventSummary, MethodExecutionNodeSummary,
    MethodExecutionSummary, MethodWorkflowNode,
};
use super::paths::{method_dir, project_root, validate_method_id};
use super::storage::{hash_directory, hex, read_manifest};
use super::validation::validate_method;

fn method_level_config_string(method: &MethodDocument, key: &str) -> Option<String> {
    yaml_string(yaml_lookup(&method.parameters, key))
        .or_else(|| yaml_string(yaml_lookup(&method.provider, key)))
}

pub(crate) async fn insert_execution(
    db: &DatabaseState,
    method: &MethodDocument,
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
    tracing::info!(
        execution_id,
        method_id = %method.id,
        content_hash,
        nodes = method.workflow.nodes.len(),
        provider = ?method_level_config_string(method, "provider"),
        server_url = ?method_level_config_string(method, "server_url"),
        model_values = ?model_values(method),
        "Created Method execution"
    );
    for node in runnable_nodes(method) {
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
        "method_execution_file" => {
            let root = project_root(db)?;
            let path = root.join(&artifact.storage_ref);
            fs::read_to_string(&path).map_err(|e| {
                format!("Failed to read Method artifact file '{}': {}", path.display(), e)
            })
        }
        "inference_job" => Ok(format!("Inference job {}", artifact.storage_ref)),
        "job_set" => Ok(format!("Inference jobs {}", artifact.storage_ref)),
        other => Err(format!("Unsupported method artifact storage kind: {}", other)),
    }
}

pub(crate) fn topological_nodes(
    nodes: &[MethodWorkflowNode],
) -> Result<Vec<MethodWorkflowNode>, String> {
    let all_nodes: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut remaining: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().filter(|n| n.is_runnable()).map(|n| (n.id.as_str(), n)).collect();
    let mut done = HashSet::new();
    let mut ordered = Vec::new();

    while !remaining.is_empty() {
        let ready_id = remaining
            .values()
            .find(|node| {
                node.depends_on.iter().all(|dep| {
                    all_nodes.get(dep.as_str()).is_some_and(|dep_node| dep_node.is_resource())
                        || done.contains(dep.as_str())
                })
            })
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
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    data_source_override: Option<String>,
    model_override: Option<&str>,
    name_suffix: Option<&str>,
) -> Result<i64, String> {
    let prompt_file = resolve_configured_file(
        method,
        &method.id,
        &node.id,
        config_string(node, method, "prompt_file", None),
        "prompt",
    )?;
    let has_upstream_sample = data_source_override.is_some();
    let data_source = match data_source_override {
        Some(source) => source,
        None => resolve_configured_file(
            method,
            &method.id,
            &node.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let json_schema_file = if config_string(node, method, "output_mode", Some("Unstructured"))
        .as_deref()
        == Some("JSON Schema")
    {
        Some(resolve_configured_file(
            method,
            &method.id,
            &node.id,
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
    let provider =
        config_string(node, method, "provider", Some("Local")).unwrap_or_else(|| "Local".into());
    let model = model_override
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| config_string(node, method, "model", Some("")).unwrap_or_default());
    let server_url = config_string(node, method, "server_url", Some("")).unwrap_or_default();
    let output_mode = config_string(node, method, "output_mode", Some("Unstructured"))
        .unwrap_or_else(|| "Unstructured".into());
    let temperature = config_f64(node, method, "temperature");
    let max_tokens = config_i32(node, method, "max_tokens", None);
    let samples = if has_upstream_sample {
        1
    } else {
        config_i32(node, method, "samples", Some(1)).unwrap_or(1)
    };
    let strategy = if has_upstream_sample {
        "exhaustive".to_string()
    } else {
        config_string(node, method, "strategy", Some("single")).unwrap_or_else(|| "single".into())
    };
    if server_url.trim().is_empty() {
        tracing::warn!(
            execution_id,
            method_id = %method.id,
            node_id = %node.id,
            provider = %provider,
            model = %model,
            model_override = ?model_override,
            "Creating Method inference job with an empty server_url"
        );
    }
    tracing::info!(
        execution_id,
        method_id = %method.id,
        node_id = %node.id,
        job_name = %name,
        provider = %provider,
        model = %model,
        server_url = %server_url,
        output_mode = %output_mode,
        temperature = ?temperature,
        max_tokens = ?max_tokens,
        samples,
        strategy = %strategy,
        prompt_file = %prompt_file,
        data_source = %data_source,
        json_schema_file = ?json_schema_file,
        "Creating Method inference job"
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
    .bind(provider)
    .bind(model)
    .bind(server_url)
    .bind(output_mode)
    .bind(temperature)
    .bind(max_tokens)
    .bind(config_i32(node, method, "thinking_budget", None))
    .bind(samples)
    .bind(strategy)
    .bind(json_schema_file)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create inference job for method node '{}': {}", node.id, e))?;
    Ok(result.last_insert_rowid())
}

pub(crate) async fn create_sample_job_for_node(
    db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    data_source_override: Option<String>,
) -> Result<i64, String> {
    let data_source = match data_source_override {
        Some(source) => source,
        None => resolve_configured_file(
            method,
            &method.id,
            &node.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let name = format!("method-{}-{}-{}", method.id, execution_id, node.id);
    let samples = config_i32(node, method, "samples", Some(1)).unwrap_or(1);
    let strategy =
        config_string(node, method, "strategy", Some("single")).unwrap_or_else(|| "single".into());

    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, status
        )
        VALUES (
            'sample', ?1, '', ?2, 'Nightshift', 'Sampling', '', 'Sample',
            ?3, ?4, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(data_source)
    .bind(samples)
    .bind(strategy)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create sample job for method node '{}': {}", node.id, e))?;

    Ok(result.last_insert_rowid())
}

pub(crate) async fn create_transform_job_for_node(
    db: &DatabaseState,
    method: &MethodDocument,
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
            &node.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let script_file = resolve_configured_file(
        method,
        &method.id,
        &node.id,
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
    .bind(config_string(node, method, "error_mode", Some("stop")).unwrap_or_else(|| "stop".into()))
    .bind(
        config_string(node, method, "output_mode", Some("one_to_one"))
            .unwrap_or_else(|| "one_to_one".into()),
    )
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
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(dep) = runnable_dependency_ids(method, node).next() else {
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
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Vec<(i64, String)>, String> {
    let Some(dep) = runnable_dependency_ids(method, node).next() else {
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
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let models = model_values(method);
    tracing::info!(
        execution_id,
        method_id = %method.id,
        node_id = %node.id,
        models = ?models,
        provider = ?config_string(node, method, "provider", None),
        server_url = ?config_string(node, method, "server_url", None),
        model = ?config_string(node, method, "model", None),
        "Running Method inference node"
    );
    let upstream_source = upstream_collection_source(db, method, node, node_outputs).await?;
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
            upstream_source.clone(),
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
            upstream_source.clone(),
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

pub(crate) async fn run_sample_agent(
    app: &AppHandle,
    db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let upstream_source = upstream_collection_source(db, method, node, node_outputs).await?;
    let job_id =
        create_sample_job_for_node(db, method, node, execution_id, upstream_source).await?;
    insert_event(
        app,
        db,
        execution_id,
        Some(&node.id),
        "sample_job_created",
        serde_json::json!({
            "jobId": job_id,
            "samples": config_i32(node, method, "samples", Some(1)).unwrap_or(1),
            "strategy": config_string(node, method, "strategy", Some("single")).unwrap_or_else(|| "single".into()),
        }),
    )
    .await?;
    run_job_agent(app, db, execution_id, &node.id, job_id).await
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
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let upstream_sources = upstream_job_sources(db, method, node, node_outputs).await?;
    if upstream_sources.is_empty() {
        let upstream_source = upstream_collection_source(db, method, node, node_outputs).await?;
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
            "description": "List the current Method execution context, upstream node outputs, node statuses, artifacts, and useful local SQLite tables for experiment analysis.",
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
            "description": "Run one read-only SELECT or WITH query against the local Nightshift SQLite database. Useful tables: method_executions, method_execution_nodes, method_execution_events, method_artifacts, inference_jobs, collections, collection_items, job_failures. Results are capped.",
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
                "job_ids": node_outputs.get(&dep).map(|output| parse_job_ids(output).unwrap_or_default()).unwrap_or_default(),
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
    let artifacts = sqlx::query_as::<_, MethodArtifactSummary>(
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
    .map_err(|e| format!("Failed to read execution artifacts for analysis: {}", e))?;
    Ok(serde_json::json!({
        "execution_id": execution_id,
        "analysis_node_id": node.id,
        "upstream_outputs": upstream_outputs,
        "execution_nodes": nodes,
        "artifacts": artifacts,
        "useful_tables": [
            "method_executions",
            "method_execution_nodes",
            "method_execution_events",
            "method_artifacts",
            "inference_jobs",
            "collections",
            "collection_items",
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
    method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
) -> Result<PathBuf, String> {
    let file_name = if node.node_type == "output_file" {
        node.path.clone().unwrap_or_else(|| format!("{}.md", node.id))
    } else {
        format!("{}.md", node.id)
    };
    let file_name = file_name.trim();
    if file_name.is_empty() {
        return Err("output_file path must not be empty".into());
    }
    let configured = Path::new(file_name);
    if configured.is_absolute() {
        return Err("output_file path must be relative".into());
    }
    if file_name.contains("..") {
        return Err("output_file path must stay inside the execution folder".into());
    }
    let mut relative = PathBuf::from(".nightshift")
        .join("executions")
        .join(execution_id.to_string())
        .join(&method.id)
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

async fn mark_execution_cancelled(
    app: &AppHandle,
    db: &DatabaseState,
    execution_id: i64,
    node_id: Option<&str>,
) -> Result<(), String> {
    if let Some(node_id) = node_id {
        update_node_status(db, execution_id, node_id, "cancelled", None, None).await?;
    }
    update_execution_status(db, execution_id, "cancelled", None).await?;
    insert_event(app, db, execution_id, node_id, "execution_cancelled", serde_json::json!({})).await
}

async fn run_method_node(
    app: &AppHandle,
    db: &DatabaseState,
    method: &MethodDocument,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
    had_not_implemented: &mut bool,
) -> Result<String, String> {
    match node.node_type.as_str() {
        "sample" => run_sample_agent(app, db, method, node, execution_id, node_outputs).await,
        "inference" => run_inference_agent(app, db, method, node, execution_id, node_outputs).await,
        "transform" => run_transform_agent(app, db, method, node, execution_id, node_outputs).await,
        "eval"
            if method_file_by_kind(method, "script").is_some()
                || config_string(node, method, "script_file", None).is_some() =>
        {
            run_transform_agent(app, db, method, node, execution_id, node_outputs).await
        }
        "aggregate" => {
            insert_event(
                app,
                db,
                execution_id,
                Some(&node.id),
                "node_type_deprecated",
                serde_json::json!({
                    "from": "aggregate",
                    "to": "analysis",
                    "message": "Aggregate nodes are deprecated and now execute as analysis report nodes."
                }),
            )
            .await?;
            run_analysis_agent(db, method, execution_id, node, node_outputs).await
        }
        "analysis" | "output_file" => {
            run_analysis_agent(db, method, execution_id, node, node_outputs).await
        }
        "eval" => {
            *had_not_implemented = true;
            let artifact = run_not_implemented_agent(db, execution_id, node).await?;
            update_node_status(
                db,
                execution_id,
                &node.id,
                "not_implemented",
                Some(&artifact),
                Some("Agent implementation is not available yet"),
            )
            .await?;
            insert_event(
                app,
                db,
                execution_id,
                Some(&node.id),
                "node_not_implemented",
                serde_json::json!({ "nodeType": node.node_type, "artifact": artifact }),
            )
            .await?;
            Ok(artifact)
        }
        other => Err(format!("Unknown method node type '{}'", other)),
    }
}

pub(crate) async fn orchestrate_method_execution(
    app: AppHandle,
    db: DatabaseState,
    execution_id: i64,
    method: MethodDocument,
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

    let ordered_nodes = topological_nodes(&method.workflow.nodes)?;
    if ordered_nodes.is_empty() {
        return Err("method.workflow.nodes must contain at least one node".into());
    }

    let mut node_outputs = HashMap::new();
    let mut had_not_implemented = false;
    for node in ordered_nodes {
        if let Err(e) = wait_if_paused(&app, &db, execution_id, &control).await {
            if control.cancel_requested.load(Ordering::SeqCst) {
                mark_execution_cancelled(&app, &db, execution_id, Some(&node.id)).await?;
                return Ok(());
            }
            return Err(e);
        }
        if control.cancel_requested.load(Ordering::SeqCst) {
            mark_execution_cancelled(&app, &db, execution_id, Some(&node.id)).await?;
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

        let is_not_implemented_eval = node.node_type == "eval"
            && method_file_by_kind(&method, "script").is_none()
            && config_string(&node, &method, "script_file", None).is_none();

        match run_method_node(
            &app,
            &db,
            &method,
            execution_id,
            &node,
            &node_outputs,
            &mut had_not_implemented,
        )
        .await
        {
            Ok(output_ref) => {
                node_outputs.insert(node.id.clone(), output_ref.clone());
                if !is_not_implemented_eval {
                    update_node_status(
                        &db,
                        execution_id,
                        &node.id,
                        "completed",
                        Some(&output_ref),
                        None,
                    )
                    .await?;
                }
                if !is_not_implemented_eval {
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
    tracing::info!(
        project_root = %root.display(),
        method_id = %method.id,
        title = %method.title,
        folder = %folder.display(),
        content_hash = %content_hash,
        provider = ?method_level_config_string(&method, "provider"),
        server_url = ?method_level_config_string(&method, "server_url"),
        model_values = ?model_values(&method),
        "Starting Method execution command"
    );
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
