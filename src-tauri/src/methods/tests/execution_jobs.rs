use super::*;

#[test]
fn topological_nodes_orders_dependencies_first() {
    let method = sample_method();

    let ordered = topological_nodes(&method.workflow.nodes).unwrap();

    assert_eq!(
        ordered.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
        vec!["generate", "analysis",]
    );
}

#[tokio::test]
async fn insert_execution_creates_node_rows() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-execution-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let method = sample_method();

    let execution_id = insert_execution(&db, &method, "hash").await.unwrap();
    let nodes = sqlx::query_as::<_, MethodExecutionNodeSummary>(
        "SELECT id, execution_id, node_id, node_type, status, output_ref, error_message, started_at, completed_at FROM method_execution_nodes WHERE execution_id = ? ORDER BY id",
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .unwrap();

    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0].node_id, "generate");
    assert_eq!(nodes[0].status, "queued");
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn insert_execution_cleans_up_when_execution_folder_creation_fails() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-execution-cleanup-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    fs::write(temp.join(".nightshift/executions"), "not a directory").unwrap();

    let err = insert_execution(&db, &sample_method(), "hash").await.unwrap_err();
    let execution_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM method_executions")
        .fetch_one(&db.pool())
        .await
        .unwrap();

    assert!(err.contains("Failed to create execution snapshot folder"), "got: {err}");
    assert_eq!(execution_count, 0);
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn execution_yaml_tracks_status_transitions() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-execution-yaml-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
    let metadata_path = temp
        .join(".nightshift")
        .join("executions")
        .join(execution_id.to_string())
        .join("execution.yaml");

    let queued: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    assert_eq!(queued["status"].as_str(), Some("queued"));

    update_execution_status(&db, execution_id, "running", None).await.unwrap();
    let running: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    assert_eq!(running["status"].as_str(), Some("running"));
    assert!(running["startedAt"].as_str().is_some());

    update_execution_status(&db, execution_id, "failed", Some("boom")).await.unwrap();
    let failed: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    assert_eq!(failed["status"].as_str(), Some("failed"));
    assert_eq!(failed["errorMessage"].as_str(), Some("boom"));
    assert!(failed["completedAt"].as_str().is_some());
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn create_inference_job_for_node_uses_frozen_method_files() {
    let temp = std::env::temp_dir().join(format!("nightshift-method-job-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let mut method = sample_method();
    add_resource_dependency(
        &mut method,
        method_resource("data", "data", "data/examples.jsonl"),
        "generate",
    );
    method.provider = serde_yaml::from_str(
        r#"
provider: Local
server_url: http://localhost:1234
model: qwen-test
"#,
    )
    .unwrap();

    let (frozen, execution_id) = prepare_frozen_execution(&db, &temp, method).await;
    let job_id = create_inference_job_for_node(
        &db,
        &frozen,
        &frozen.workflow.nodes[0],
        execution_id,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    let snapshot_prefix = format!(".nightshift/executions/{}/snapshot/files/", execution_id);
    assert!(job.prompt_file.starts_with(&snapshot_prefix));
    assert!(job.data_source.starts_with(&snapshot_prefix));
    assert_eq!(job.model, "qwen-test");
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn create_inference_job_for_node_prefers_prompt_consumed_by_node() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-node-prompt-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/generate.jinja2"), "Generate {{name}}").unwrap();
    fs::write(temp.join("prompts/judge.jinja2"), "Judge {{word_de}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let method = MethodDocument {
        schema_version: 2,
        id: "node-prompt-method".into(),
        title: "Node prompt method".into(),
        objective: "Use node-specific prompts".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("generate_prompt", "prompt", "prompts/generate.jinja2"),
                method_resource("judge_prompt", "prompt", "prompts/judge.jinja2"),
                method_resource("data", "data", "data/examples.jsonl"),
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["generate_prompt".into(), "data".into()],
                    config: serde_json::Value::Null,
                },
                MethodWorkflowNode {
                    id: "judge".into(),
                    label: "Judge".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["generate".into(), "judge_prompt".into()],
                    config: serde_json::Value::Null,
                },
            ],
        },
        parameters: serde_json::Value::Null,
        provider: serde_json::json!({
            "provider": "Local",
            "server_url": "http://localhost:1234",
            "model": "qwen-test",
        }),
        outputs: vec![],
        metadata: serde_json::Value::Null,
    };

    let (frozen, execution_id) = prepare_frozen_execution(&db, &temp, method).await;
    let judge_node = frozen.workflow.nodes.iter().find(|node| node.id == "judge").unwrap();

    let job_id = create_inference_job_for_node(
        &db,
        &frozen,
        judge_node,
        execution_id,
        Some("execution:42/node:generate".into()),
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert!(job
        .prompt_file
        .starts_with(&format!(".nightshift/executions/{}/snapshot/files/", execution_id)));
    assert!(job.prompt_file.ends_with(".jinja2"));
    let prompt = fs::read_to_string(temp.join(&job.prompt_file)).unwrap();
    assert_eq!(prompt, "Judge {{word_de}}");
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn create_inference_job_for_node_uses_upstream_sample_without_resampling() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-sampled-inference-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let mut method = sample_method();
    add_resource_dependency(
        &mut method,
        method_resource("data", "data", "data/examples.jsonl"),
        "generate",
    );
    method.provider = serde_json::json!({
        "provider": "Local",
        "server_url": "http://localhost:1234",
        "model": "qwen-test"
    });
    method.parameters = serde_json::json!({
        "samples": 99,
        "strategy": "random"
    });
    let (frozen, execution_id) = prepare_frozen_execution(&db, &temp, method).await;

    let job_id = create_inference_job_for_node(
        &db,
        &frozen,
        frozen.workflow.nodes.iter().find(|node| node.id == "generate").unwrap(),
        execution_id,
        Some("execution:42/node:sample".into()),
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert_eq!(job.data_source, "execution:42/node:sample");
    assert_eq!(job.samples, 1);
    assert_eq!(job.strategy, "exhaustive");
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn create_sample_job_for_node_persists_sampling_config() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-sample-job-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let method = MethodDocument {
        schema_version: 2,
        id: "sample-method".into(),
        title: "Sample method".into(),
        objective: "Share one sample".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("data", "data", "data/examples.jsonl"),
                MethodWorkflowNode {
                    id: "sample_records".into(),
                    label: "Sample records".into(),
                    node_type: "sample".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["data".into()],
                    config: serde_json::json!({ "samples": 2, "strategy": "random" }),
                },
            ],
        },
        parameters: serde_json::Value::Null,
        provider: serde_json::Value::Null,
        outputs: vec![],
        metadata: serde_json::Value::Null,
    };
    let (frozen, execution_id) = prepare_frozen_execution(&db, &temp, method).await;

    let sample_node =
        frozen.workflow.nodes.iter().find(|node| node.id == "sample_records").unwrap();
    let job_id =
        create_sample_job_for_node(&db, &frozen, sample_node, execution_id, None).await.unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert_eq!(job.job_type, "sample");
    assert!(job
        .data_source
        .starts_with(&format!(".nightshift/executions/{}/snapshot/files/", execution_id)));
    assert_eq!(job.samples, 2);
    assert_eq!(job.strategy, "random");
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn create_transform_job_for_node_uses_frozen_script_and_data() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-transform-job-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::create_dir_all(temp.join("scripts")).unwrap();
    fs::write(temp.join("prompts-main-placeholder"), "").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"value":1}"#).unwrap();
    fs::write(temp.join("scripts/score.js"), "return item;").unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let mut method = sample_method();
    method.workflow.nodes = vec![
        method_resource("data", "data", "data/examples.jsonl"),
        method_resource("script", "eval_script", "scripts/score.js"),
        MethodWorkflowNode {
            id: "score".into(),
            label: "Score".into(),
            node_type: "transform".into(),
            kind: None,
            path: None,
            reference: None,
            depends_on: vec!["data".into(), "script".into()],
            config: serde_json::Value::Null,
        },
    ];

    let (frozen, execution_id) = prepare_frozen_execution(&db, &temp, method).await;
    let job_id = create_transform_job_for_node(
        &db,
        &frozen,
        frozen.workflow.nodes.iter().find(|node| node.id == "score").unwrap(),
        execution_id,
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert_eq!(job.job_type, "transform");
    let snapshot_prefix = format!(".nightshift/executions/{}/snapshot/files/", execution_id);
    assert!(job.data_source.starts_with(&snapshot_prefix));
    assert!(job.transform_script_file.unwrap().starts_with(&snapshot_prefix));
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn upstream_job_sources_returns_real_job_scoped_execution_refs() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-upstream-jobs-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let method = sample_method();
    let execution_id = insert_execution(&db, &method, "hash").await.unwrap();
    sqlx::query(
        "UPDATE method_execution_nodes SET status = 'completed' WHERE execution_id = ? AND node_id = 'generate'",
    )
    .bind(execution_id)
    .execute(&db.pool())
    .await
    .unwrap();
    for job_id in [101_i64, 202_i64] {
        sqlx::query(
            "INSERT INTO method_execution_outputs (execution_id, node_id, job_id, sample_index, data) VALUES (?, 'generate', ?, 0, ?)",
        )
        .bind(execution_id)
        .bind(job_id)
        .bind(serde_json::json!({ "job": job_id }))
        .execute(&db.pool())
        .await
        .unwrap();
    }

    let analysis_node = method.workflow.nodes.iter().find(|node| node.id == "analysis").unwrap();
    let mut node_outputs = std::collections::HashMap::new();
    node_outputs
        .insert("generate".to_string(), format!("execution:{}/node:generate", execution_id));

    let sources = upstream_job_sources(&db, &method, analysis_node, &node_outputs).await.unwrap();

    assert_eq!(
        sources,
        vec![
            (101, format!("execution:{}/node:generate/job:101", execution_id)),
            (202, format!("execution:{}/node:generate/job:202", execution_id)),
        ]
    );
    fs::remove_dir_all(temp).unwrap();
}
