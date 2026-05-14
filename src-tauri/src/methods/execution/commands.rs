use super::*;

pub async fn execute_method_file(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    method_path: String,
) -> Result<MethodExecutionSummary, String> {
    validate_method_source_path(&method_path)?;
    let root = project_root(&db)?;
    let method = read_method_document(&root.join(&method_path))?;
    let completeness = preflight_method_for_root(&method, &root);
    if completeness.status != "ready" {
        return Err(format!(
            "Method is not ready to execute. {}",
            format_preflight_blockers(&completeness)
        ));
    }
    let manifest_text = serde_yaml::to_string(&method)
        .map_err(|e| format!("Failed to serialize Method for hashing: {}", e))?;
    let content_hash = hex(&Sha256::digest(manifest_text.as_bytes()));
    let execution_id =
        start_method_execution(app, db.clone(), manager, method, content_hash).await?;
    sqlx::query_as::<_, MethodExecutionSummary>(
        r#"
        SELECT id, method_id, method_content_hash, status, error_message, created_at, started_at, completed_at
        FROM method_executions
        WHERE id = ?1
        "#,
    )
    .bind(execution_id)
    .fetch_one(&db.pool())
    .await
    .map_err(|e| format!("Failed to read execution summary: {}", e))
}

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

pub async fn get_execution_method(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    read_method_document(&execution_dir(&root, execution_id).join("snapshot").join("method.yaml"))
}

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

pub async fn get_method_execution_artifacts(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodArtifactSummary>, String> {
    sqlx::query_as::<_, MethodArtifactSummary>(
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
    .map_err(|e| format!("Failed to list method execution files: {}", e))
}

pub async fn get_execution_files(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<ExecutionFileSummary>, String> {
    get_method_execution_artifacts(db, execution_id).await
}

pub async fn get_execution_node_outputs(
    db: State<'_, DatabaseState>,
    execution_id: i64,
    node_id: String,
    page: i32,
    page_size: i32,
) -> Result<Vec<OutputItem>, String> {
    let offset = (page.max(1) - 1) * page_size.max(1);
    sqlx::query_as::<_, OutputItem>(
        r#"
        SELECT id, execution_id, node_id, job_id, sample_index, data, created_at
        FROM method_execution_outputs
        WHERE execution_id = ?1 AND node_id = ?2
        ORDER BY id ASC
        LIMIT ?3 OFFSET ?4
        "#,
    )
    .bind(execution_id)
    .bind(node_id)
    .bind(page_size.max(1))
    .bind(offset)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list execution outputs: {}", e))
}

pub async fn get_execution_log(
    db: State<'_, DatabaseState>,
    execution_id: i64,
    filter: Option<String>,
    page: i32,
    page_size: i32,
) -> Result<Vec<MethodExecutionEventSummary>, String> {
    let offset = (page.max(1) - 1) * page_size.max(1);
    if let Some(event_type) = filter.filter(|value| !value.trim().is_empty()) {
        sqlx::query_as::<_, MethodExecutionEventSummary>(
            r#"
            SELECT id, execution_id, node_id, event_type, payload_json, created_at
            FROM method_execution_events
            WHERE execution_id = ?1 AND event_type = ?2
            ORDER BY id ASC
            LIMIT ?3 OFFSET ?4
            "#,
        )
        .bind(execution_id)
        .bind(event_type)
        .bind(page_size.max(1))
        .bind(offset)
        .fetch_all(&db.pool())
        .await
        .map_err(|e| format!("Failed to list execution log: {}", e))
    } else {
        sqlx::query_as::<_, MethodExecutionEventSummary>(
            r#"
            SELECT id, execution_id, node_id, event_type, payload_json, created_at
            FROM method_execution_events
            WHERE execution_id = ?1
            ORDER BY id ASC
            LIMIT ?2 OFFSET ?3
            "#,
        )
        .bind(execution_id)
        .bind(page_size.max(1))
        .bind(offset)
        .fetch_all(&db.pool())
        .await
        .map_err(|e| format!("Failed to list execution log: {}", e))
    }
}

pub async fn read_method_artifact(
    db: State<'_, DatabaseState>,
    artifact_id: i64,
) -> Result<String, String> {
    read_method_artifact_from_db(&db, artifact_id).await
}

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
