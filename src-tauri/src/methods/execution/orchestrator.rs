use super::*;

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
        "analysis" => run_analysis_agent(db, method, execution_id, node, node_outputs).await,
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

pub(crate) async fn start_method_execution(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    method: MethodDocument,
    content_hash: String,
) -> Result<i64, String> {
    tracing::info!(
        method_id = %method.id,
        title = %method.title,
        content_hash = %content_hash,
        provider = ?method_level_config_string(&method, "provider"),
        server_url = ?method_level_config_string(&method, "server_url"),
        model_values = ?model_values(&method),
        "Starting Method execution command"
    );
    let execution_id = insert_execution(&db, &method, &content_hash).await?;
    let method = match snapshot_method_for_execution(&db, execution_id, &method) {
        Ok(method) => method,
        Err(error) => {
            let cleanup_error = cleanup_failed_execution_start(&db, execution_id).await.err();
            return Err(match cleanup_error {
                Some(cleanup_error) => format!("{}; additionally, {}", error, cleanup_error),
                None => error,
            });
        }
    };
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
