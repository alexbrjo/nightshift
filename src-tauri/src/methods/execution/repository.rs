use super::*;

pub(crate) async fn record_execution_output(
    db: &DatabaseState,
    execution_id: i64,
    node_id: &str,
    job_id: i64,
    sample_index: i64,
    data: &serde_json::Value,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO method_execution_outputs (execution_id, node_id, job_id, sample_index, data)
        VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
    )
    .bind(execution_id)
    .bind(node_id)
    .bind(job_id)
    .bind(sample_index)
    .bind(data)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to index execution output: {}", e))?;
    let root = project_root(db)?;
    append_jsonl(
        &execution_output_path(&root, execution_id, node_id),
        &serde_json::json!({
            "jobId": job_id,
            "sampleIndex": sample_index,
            "data": data,
        }),
    )
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
    if let Err(error) = ensure_execution_folder(db, execution_id, method, content_hash) {
        let cleanup_error = cleanup_failed_execution_start(db, execution_id).await.err();
        return Err(match cleanup_error {
            Some(cleanup_error) => format!("{}; additionally, {}", error, cleanup_error),
            None => error,
        });
    }
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
        let node_result = sqlx::query(
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
        .map_err(|e| format!("Failed to create method execution node: {}", e));
        if let Err(error) = node_result {
            let cleanup_error = cleanup_failed_execution_start(db, execution_id).await.err();
            return Err(match cleanup_error {
                Some(cleanup_error) => format!("{}; additionally, {}", error, cleanup_error),
                None => error,
            });
        }
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
    rewrite_execution_metadata(db, execution_id).await
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

    let root = project_root(db)?;
    append_jsonl(
        &execution_log_path(&root, execution_id),
        &serde_json::json!({
            "type": event_type,
            "nodeId": node_id,
            "payload": payload,
        }),
    )?;

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

    let file_type = if storage_kind.starts_with("inline") { storage_kind } else { artifact_type };
    sqlx::query(
        r#"
        INSERT INTO method_execution_files (
            execution_id, node_id, file_type, path, content_hash
        )
        VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
    )
    .bind(execution_id)
    .bind(node_id)
    .bind(file_type)
    .bind(storage_ref)
    .bind(&hash)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to record method artifact: {}", e))?;

    Ok(format!("file:{}", storage_ref))
}

pub(crate) async fn read_method_artifact_from_db(
    db: &DatabaseState,
    artifact_id: i64,
) -> Result<String, String> {
    let artifact = sqlx::query_as::<_, MethodArtifactSummary>(
        r#"
        SELECT id, execution_id, node_id, file_type, path, content_hash, created_at
        FROM method_execution_files
        WHERE id = ?1
        "#,
    )
    .bind(artifact_id)
    .fetch_optional(&db.pool())
    .await
    .map_err(|e| format!("Failed to read method artifact: {}", e))?
    .ok_or_else(|| "Method artifact not found".to_string())?;

    match artifact.file_type.as_str() {
        "inline_json" | "inline_markdown" | "inline" => Ok(artifact.path),
        "method_execution_file" | "analysis" | "not_implemented" => {
            let root = project_root(db)?;
            super::super::paths::validate_execution_artifact_relative_path(&artifact.path)?;
            let path = root.join(&artifact.path);
            let root_canonical = fs::canonicalize(&root)
                .map_err(|e| format!("Failed to resolve project root: {}", e))?;
            let path_canonical = fs::canonicalize(&path).map_err(|e| {
                format!("Failed to resolve Method artifact file '{}': {}", path.display(), e)
            })?;
            if !path_canonical.starts_with(&root_canonical) {
                return Err("Method artifact path is outside the project root".to_string());
            }
            fs::read_to_string(&path_canonical).map_err(|e| {
                format!("Failed to read Method artifact file '{}': {}", path_canonical.display(), e)
            })
        }
        other => Err(format!("Unsupported execution file type: {}", other)),
    }
}
