use super::*;

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
            JobEvent::SampleCompleted { sample_index, output, .. } => {
                record_execution_output(
                    db,
                    execution_id,
                    node_id,
                    job_id,
                    *sample_index as i64,
                    output,
                )
                .await?;
            }
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
    Ok(execution_node_ref(execution_id, node_id))
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
    let upstream_source = upstream_output_source(db, method, node, node_outputs).await?;
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
    insert_event(
        app,
        db,
        execution_id,
        Some(&node.id),
        "sweep_job_set_created",
        serde_json::json!({
            "jobIds": job_ids,
            "outputRef": execution_node_ref(execution_id, &node.id),
        }),
    )
    .await?;
    Ok(execution_node_ref(execution_id, &node.id))
}

pub(crate) async fn run_sample_agent(
    app: &AppHandle,
    db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let upstream_source = upstream_output_source(db, method, node, node_outputs).await?;
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
        let upstream_source = upstream_output_source(db, method, node, node_outputs).await?;
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
    Ok(execution_node_ref(execution_id, &node.id))
}
