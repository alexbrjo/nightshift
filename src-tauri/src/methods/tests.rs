use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use uuid::Uuid;

use crate::database::DatabaseState;

use super::config::model_values;
use super::draft::{
    create_draft_for_root, default_draft, get_current_draft_for_root, validate_graph,
};
use super::execution::{
    create_inference_job_for_node, create_transform_job_for_node, insert_artifact,
    insert_execution, read_method_artifact_from_db, run_aggregate_agent, topological_nodes,
};
use super::model::*;
use super::preflight::preflight_method_for_root;
use super::storage::{freeze_files, read_manifest, save_method_to_project};
use super::validation::validate_method;

fn sample_method() -> MethodManifest {
    MethodManifest {
        schema_version: 1,
        id: "edge-method".into(),
        title: "Edge method".into(),
        objective: Some("Compare local models".into()),
        files: vec![MethodFileRef {
            id: "prompt".into(),
            kind: "prompt".into(),
            path: "prompts/main.jinja2".into(),
        }],
        workflow: MethodWorkflow {
            nodes: vec![
                MethodWorkflowNode {
                    id: "generate".into(),
                    node_type: "inference".into(),
                    depends_on: vec![],
                    config: serde_yaml::Value::Null,
                },
                MethodWorkflowNode {
                    id: "aggregate".into(),
                    node_type: "aggregate".into(),
                    depends_on: vec!["generate".into()],
                    config: serde_yaml::Value::Null,
                },
            ],
        },
        parameters: serde_yaml::Value::Null,
        provider: serde_yaml::Value::Null,
    }
}

#[test]
fn method_lifecycle_allows_expected_state_transitions() {
    assert!(MethodLifecycleState::Drafting.can_transition_to(MethodLifecycleState::Ready));
    assert!(MethodLifecycleState::Ready.can_transition_to(MethodLifecycleState::Executing));
    assert!(MethodLifecycleState::Executing.can_transition_to(MethodLifecycleState::Completed));
    assert!(MethodLifecycleState::Executing.can_transition_to(MethodLifecycleState::Failed));
    assert!(!MethodLifecycleState::Completed.can_transition_to(MethodLifecycleState::Executing));
    assert!(!MethodLifecycleState::Failed.can_transition_to(MethodLifecycleState::Completed));
}

#[test]
fn draft_creation_defaults_and_required_fields_are_reported() {
    let draft = default_draft(CreateMethodDraftInput { title: None, objective: None });

    assert_eq!(draft.schema_version, 1);
    assert!(draft.id.starts_with("draft-"));
    assert_eq!(draft.title, "Untitled Method");
    assert_eq!(draft.lifecycle, MethodLifecycleState::Drafting);
    assert!(draft.readiness.blockers.iter().any(|blocker| blocker.code == "missing_title"));
    assert!(draft.readiness.blockers.iter().any(|blocker| blocker.code == "missing_objective"));
    assert!(draft.readiness.blockers.iter().any(|blocker| blocker.code == "missing_nodes"));
}

#[test]
fn draft_graph_validation_rejects_unknown_edge_endpoints() {
    let nodes = vec![MethodDraftNode {
        id: "generate".into(),
        label: "Generate".into(),
        node_type: "inference".into(),
        status: "draft".into(),
        config: serde_json::json!({}),
    }];
    let edges = vec![MethodDraftEdge { from: "generate".into(), to: "score".into() }];

    let err = validate_graph(&nodes, &edges).unwrap_err();

    assert!(err.contains("unknown node 'score'"), "got: {err}");
}

#[test]
fn draft_graph_validation_rejects_cycles() {
    let nodes = vec![
        MethodDraftNode {
            id: "a".into(),
            label: "A".into(),
            node_type: "inference".into(),
            status: "draft".into(),
            config: serde_json::json!({}),
        },
        MethodDraftNode {
            id: "b".into(),
            label: "B".into(),
            node_type: "eval".into(),
            status: "draft".into(),
            config: serde_json::json!({}),
        },
    ];
    let edges = vec![
        MethodDraftEdge { from: "a".into(), to: "b".into() },
        MethodDraftEdge { from: "b".into(), to: "a".into() },
    ];

    let err = validate_graph(&nodes, &edges).unwrap_err();

    assert!(err.contains("cycle"), "got: {err}");
}

#[test]
fn agent_tool_style_draft_creation_persists_current_draft() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-draft-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join(".nightshift")).unwrap();

    let draft = create_draft_for_root(
        &temp,
        CreateMethodDraftInput {
            title: Some("Model rubric benchmark".into()),
            objective: Some("Compare generated answers against a rubric".into()),
        },
    )
    .unwrap();
    let persisted = get_current_draft_for_root(&temp).unwrap().unwrap();

    assert_eq!(persisted.id, draft.id);
    assert_eq!(persisted.title, "Model rubric benchmark");
    assert_eq!(persisted.lifecycle, MethodLifecycleState::Drafting);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn validate_method_rejects_cycles() {
    let mut method = sample_method();
    method.workflow.nodes[0].depends_on = vec!["aggregate".into()];

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("cycle"), "got: {err}");
}

#[test]
fn validate_method_rejects_secret_values() {
    let mut method = sample_method();
    method.provider = serde_yaml::from_str("api_key: sk-test").unwrap();

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("secret-like"), "got: {err}");
}

#[tokio::test]
async fn save_method_rejects_pre_frozen_file_paths() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-prefrozen-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let mut method = sample_method();
    method.files[0].path = "files/already-frozen.jinja2".into();

    let err = save_method_to_project(&db, &temp, method).await.unwrap_err();

    assert!(err.contains("project file before save"), "got: {err}");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn freeze_files_rewrites_to_content_addressed_paths() {
    let temp = std::env::temp_dir().join(format!("nightshift-method-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    let dest = temp.join("methods/edge-method");
    let mut method = sample_method();

    freeze_files(&mut method, &temp, &dest).unwrap();

    assert!(method.files[0].path.starts_with("files/"));
    assert!(dest.join(&method.files[0].path).is_file());
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn save_method_persists_metadata_and_frozen_manifest() {
    let temp = std::env::temp_dir().join(format!("nightshift-method-db-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let mut method = sample_method();
    method.files.push(MethodFileRef {
        id: "data".into(),
        kind: "data".into(),
        path: "data/examples.jsonl".into(),
    });
    method.provider = serde_yaml::from_str("model: bonsai-8b").unwrap();

    let summary = save_method_to_project(&db, &temp, method).await.unwrap();
    let listed = sqlx::query_as::<_, MethodSummary>(
        "SELECT id, title, content_hash, folder_path, created_at FROM methods",
    )
    .fetch_all(&db.pool())
    .await
    .unwrap();
    let manifest = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();

    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "edge-method");
    assert_eq!(listed[0].content_hash, summary.content_hash);
    assert!(manifest.files[0].path.starts_with("files/"));
    assert!(PathBuf::from(&summary.folder_path).join(&manifest.files[0].path).is_file());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn topological_nodes_orders_dependencies_first() {
    let method = sample_method();

    let ordered = topological_nodes(&method.workflow.nodes).unwrap();

    assert_eq!(
        ordered.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
        vec!["generate", "aggregate",]
    );
}

#[test]
fn preflight_reports_missing_required_files() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-preflight-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let mut method = sample_method();
    method.files = vec![];

    let result = preflight_method_for_root(&method, &temp);

    assert_eq!(result.status, "drafting");
    assert!(result
        .blockers
        .iter()
        .any(|blocker| blocker.code == "missing_file"
            && blocker.file_kind.as_deref() == Some("prompt")));
    assert!(result
        .blockers
        .iter()
        .any(|blocker| blocker.code == "missing_file"
            && blocker.file_kind.as_deref() == Some("data")));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn preflight_is_ready_when_required_files_exist() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-preflight-ready-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let mut method = sample_method();
    method.files.push(MethodFileRef {
        id: "data".into(),
        kind: "data".into(),
        path: "data/examples.jsonl".into(),
    });
    method.provider = serde_yaml::from_str("model: bonsai-8b").unwrap();

    let result = preflight_method_for_root(&method, &temp);

    assert_eq!(result.status, "ready");
    assert!(result.blockers.is_empty());
    fs::remove_dir_all(temp).unwrap();
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
async fn create_inference_job_for_node_uses_frozen_method_files() {
    let temp = std::env::temp_dir().join(format!("nightshift-method-job-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let mut method = sample_method();
    method.files.push(MethodFileRef {
        id: "data".into(),
        kind: "data".into(),
        path: "data/examples.jsonl".into(),
    });
    method.provider = serde_yaml::from_str(
        r#"
provider: Local
server_url: http://localhost:1234
model: qwen-test
"#,
    )
    .unwrap();

    let summary = save_method_to_project(&db, &temp, method).await.unwrap();
    let frozen = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();
    let execution_id = insert_execution(&db, &frozen, &summary.content_hash).await.unwrap();
    let job_id = create_inference_job_for_node(
        &db,
        &frozen,
        &frozen.workflow.nodes[0],
        execution_id,
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert!(job.prompt_file.starts_with("methods/edge-method/files/"));
    assert!(job.data_source.starts_with("methods/edge-method/files/"));
    assert_eq!(job.model, "qwen-test");
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
    method.files = vec![
        MethodFileRef {
            id: "data".into(),
            kind: "data".into(),
            path: "data/examples.jsonl".into(),
        },
        MethodFileRef {
            id: "script".into(),
            kind: "script".into(),
            path: "scripts/score.js".into(),
        },
    ];
    method.workflow.nodes = vec![MethodWorkflowNode {
        id: "score".into(),
        node_type: "transform".into(),
        depends_on: vec![],
        config: serde_yaml::Value::Null,
    }];

    let summary = save_method_to_project(&db, &temp, method).await.unwrap();
    let frozen = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();
    let execution_id = insert_execution(&db, &frozen, &summary.content_hash).await.unwrap();
    let job_id = create_transform_job_for_node(
        &db,
        &frozen,
        &frozen.workflow.nodes[0],
        execution_id,
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert_eq!(job.job_type, "transform");
    assert!(job.data_source.starts_with("methods/edge-method/files/"));
    assert!(job.transform_script_file.unwrap().starts_with("methods/edge-method/files/"));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn model_values_reads_parameter_sweep() {
    let mut method = sample_method();
    method.parameters = serde_yaml::from_str(
        r#"
model_values:
  - bonsai-8b
  - qwen3.5-4b
"#,
    )
    .unwrap();

    assert_eq!(model_values(&method), vec!["bonsai-8b", "qwen3.5-4b"]);
}

#[tokio::test]
async fn aggregate_agent_summarizes_pass_fields_by_job_model() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-aggregate-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();

    let job_id = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, status
        )
        VALUES ('inference', 'agg-job', 'p', 'd', 'Local', 'bonsai-8b', 'http://localhost:1234',
            'Unstructured', 1, 'single', 'completed')
        "#,
    )
    .execute(&db.pool())
    .await
    .unwrap()
    .last_insert_rowid();
    let collection_id =
        sqlx::query("INSERT INTO collections (job_id, name) VALUES (?1, 'outputs')")
            .bind(job_id)
            .execute(&db.pool())
            .await
            .unwrap()
            .last_insert_rowid();
    for item in [serde_json::json!({ "pass": true }), serde_json::json!({ "pass": false })] {
        sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?1, ?2)")
            .bind(collection_id)
            .bind(item)
            .execute(&db.pool())
            .await
            .unwrap();
    }
    let mut node_outputs = HashMap::new();
    node_outputs.insert("score".to_string(), format!("inference_job:{}", job_id));
    let node = MethodWorkflowNode {
        id: "aggregate".into(),
        node_type: "aggregate".into(),
        depends_on: vec!["score".into()],
        config: serde_yaml::Value::Null,
    };

    let output_ref = run_aggregate_agent(&db, execution_id, &node, &node_outputs).await.unwrap();

    assert!(output_ref.starts_with("inline_json:"));
    assert!(output_ref.contains("bonsai-8b"));
    assert!(output_ref.contains("\"success_rate\": 0.5"));
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn read_method_artifact_returns_inline_content() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-artifact-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
    insert_artifact(
        &db,
        execution_id,
        Some("analysis"),
        "analysis",
        "inline_markdown",
        "# Analysis",
    )
    .await
    .unwrap();
    let artifact = sqlx::query_as::<_, MethodArtifactSummary>(
        "SELECT id, execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash, created_at FROM method_artifacts WHERE execution_id = ?",
    )
    .bind(execution_id)
    .fetch_one(&db.pool())
    .await
    .unwrap();
    let content = read_method_artifact_from_db(&db, artifact.id).await.unwrap();

    assert_eq!(content, "# Analysis");
    assert_eq!(artifact.artifact_type, "analysis");
    fs::remove_dir_all(temp).unwrap();
}
