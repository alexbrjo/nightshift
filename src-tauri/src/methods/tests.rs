use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use uuid::Uuid;

use crate::database::DatabaseState;

use super::config::{
    load_nightshift_config, model_values, resolve_api_key_id, resolve_default_provider_profile,
    resolve_provider_profile,
};
use super::draft::{
    attach_resource_for_root, create_draft_for_root, default_draft, draft_to_method_manifest,
    get_current_draft_for_root, resolve_api_key_resource_for_root,
    update_draft_execution_config_for_root, validate_graph,
};
use super::execution::{
    create_inference_job_for_node, create_transform_job_for_node, insert_artifact,
    insert_execution, method_graph_execution_plan, read_method_artifact_from_db,
    run_aggregate_agent, topological_nodes,
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
fn attaching_file_resource_persists_project_relative_status_and_consumers() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-resource-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::write(temp.join("prompts/main.md"), "Answer carefully").unwrap();
    create_draft_for_root(
        &temp,
        CreateMethodDraftInput {
            title: Some("Resource draft".into()),
            objective: Some("Attach prompt resources".into()),
        },
    )
    .unwrap();
    super::draft::replace_draft_graph_for_root(
        &temp,
        ReplaceMethodDraftGraphInput {
            nodes: vec![MethodDraftNode {
                id: "generate".into(),
                label: "Generate".into(),
                node_type: "inference".into(),
                status: "draft".into(),
                config: serde_json::json!({}),
            }],
            edges: vec![],
            resources: Some(vec![]),
        },
    )
    .unwrap();

    let draft = attach_resource_for_root(
        &temp,
        AttachMethodResourceInput {
            id: "main_prompt".into(),
            kind: "prompt".into(),
            label: Some("Main prompt".into()),
            path: Some(temp.join("prompts/main.md").to_string_lossy().into_owned()),
            reference: None,
            consumed_by: vec!["generate".into()],
        },
    )
    .unwrap();

    assert_eq!(draft.resources[0].path.as_deref(), Some("prompts/main.md"));
    assert_eq!(draft.resources[0].status, "attached");
    assert_eq!(draft.resources[0].consumed_by, vec!["generate"]);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn attaching_file_resource_rejects_dependency_folders_and_mismatched_nodes() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-bad-resource-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("node_modules/pkg")).unwrap();
    fs::write(temp.join("node_modules/pkg/prompt.md"), "nope").unwrap();
    create_draft_for_root(
        &temp,
        CreateMethodDraftInput {
            title: Some("Bad resource draft".into()),
            objective: Some("Reject bad attachments".into()),
        },
    )
    .unwrap();

    let err = attach_resource_for_root(
        &temp,
        AttachMethodResourceInput {
            id: "bad_prompt".into(),
            kind: "prompt".into(),
            label: None,
            path: Some("node_modules/pkg/prompt.md".into()),
            reference: None,
            consumed_by: vec![],
        },
    )
    .unwrap_err();
    assert!(err.contains("dependency"), "got: {err}");

    let draft = attach_resource_for_root(
        &temp,
        AttachMethodResourceInput {
            id: "schema".into(),
            kind: "json_schema".into(),
            label: Some("Schema".into()),
            path: Some("schemas/out.json".into()),
            reference: None,
            consumed_by: vec![],
        },
    )
    .unwrap();
    assert_eq!(draft.resources[0].status, "missing");
    assert!(draft.readiness.blockers.iter().any(|blocker| blocker.code == "missing_resource"));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn named_file_resource_with_path_is_not_reported_missing() {
    let draft = super::draft::refresh_readiness(MethodDraft {
        schema_version: 1,
        id: "draft-resource-status".into(),
        title: "Resource status".into(),
        objective: "Keep named resource bindings from duplicating missing blockers".into(),
        lifecycle: MethodLifecycleState::Drafting,
        resources: vec![MethodDraftResource {
            id: "data".into(),
            kind: "data".into(),
            label: "Verb dataset".into(),
            status: "named".into(),
            path: Some("100_Verben.jsonl".into()),
            reference: None,
            consumed_by: vec!["generate".into()],
        }],
        nodes: vec![MethodDraftNode {
            id: "generate".into(),
            label: "Generate".into(),
            node_type: "inference".into(),
            status: "ready".into(),
            config: serde_json::json!({}),
        }],
        edges: vec![],
        parameters: serde_json::json!({}),
        provider_config: serde_json::json!({}),
        outputs: vec![],
        metadata: serde_json::json!({}),
        readiness: MethodDraftReadiness {
            status: MethodLifecycleState::Drafting,
            blockers: vec![],
            warnings: vec![],
        },
    });

    assert!(!draft.readiness.blockers.iter().any(|blocker| blocker.code == "missing_resource"));
}

#[test]
fn ready_draft_converts_to_freezable_method_manifest() {
    let draft = MethodDraft {
        schema_version: 1,
        id: "draft-1".into(),
        title: "Edge Model Flash-Card Accuracy at 98%".into(),
        objective: "Measure edge model flash-card accuracy.".into(),
        lifecycle: MethodLifecycleState::Ready,
        resources: vec![
            MethodDraftResource {
                id: "prompt".into(),
                kind: "prompt".into(),
                label: "Prompt".into(),
                status: "attached".into(),
                path: Some("flash_cards/flash_card_prompt.jinja2".into()),
                reference: None,
                consumed_by: vec!["generate".into()],
            },
            MethodDraftResource {
                id: "schema".into(),
                kind: "json_schema".into(),
                label: "Schema".into(),
                status: "attached".into(),
                path: Some("flash_cards/flash_card.schema.json".into()),
                reference: None,
                consumed_by: vec!["generate".into()],
            },
        ],
        nodes: vec![
            MethodDraftNode {
                id: "generate".into(),
                label: "Generate".into(),
                node_type: "inference".into(),
                status: "ready".into(),
                config: serde_json::json!({ "output_mode": "JSON Schema" }),
            },
            MethodDraftNode {
                id: "analysis".into(),
                label: "Analyze".into(),
                node_type: "analysis".into(),
                status: "ready".into(),
                config: serde_json::json!({}),
            },
        ],
        edges: vec![MethodDraftEdge { from: "generate".into(), to: "analysis".into() }],
        parameters: serde_json::json!({}),
        provider_config: serde_json::json!({ "model": "qwen-test" }),
        outputs: vec![],
        metadata: serde_json::json!({}),
        readiness: MethodDraftReadiness {
            status: MethodLifecycleState::Ready,
            blockers: vec![],
            warnings: vec![],
        },
    };

    let method = draft_to_method_manifest(&draft).unwrap();

    assert_eq!(method.id, "draft-1");
    assert_eq!(method.files[0].kind, "prompt");
    assert_eq!(method.files[1].kind, "schema");
    assert_eq!(method.workflow.nodes[1].depends_on, vec!["generate"]);
    assert_eq!(method.provider.get("model").and_then(serde_yaml::Value::as_str), Some("qwen-test"));
}

#[test]
fn execution_config_update_persists_provider_model() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-config-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    create_draft_for_root(
        &temp,
        CreateMethodDraftInput {
            title: Some("Configurable Method".into()),
            objective: Some("Exercise execution config".into()),
        },
    )
    .unwrap();

    let draft = update_draft_execution_config_for_root(
        &temp,
        UpdateMethodDraftExecutionConfigInput {
            provider_config: Some(serde_json::json!({
                "model": "qwen-test",
                "serverUrl": "http://localhost:11434"
            })),
            parameters: Some(serde_json::json!({
                "modelValues": ["bonsai-8b", "qwen3.5-4b"],
                "maxTokens": 2000,
                "samples": 2
            })),
        },
    )
    .unwrap();

    assert_eq!(
        draft.provider_config.get("model").and_then(serde_json::Value::as_str),
        Some("qwen-test")
    );
    assert_eq!(
        draft.provider_config.get("server_url").and_then(serde_json::Value::as_str),
        Some("http://localhost:11434")
    );
    assert_eq!(
        draft.parameters.get("model_values").and_then(serde_json::Value::as_array).unwrap().len(),
        2
    );
    assert_eq!(draft.parameters.get("max_tokens").and_then(serde_json::Value::as_i64), Some(2000));
    assert_eq!(draft.parameters.get("samples").and_then(serde_json::Value::as_i64), Some(2));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn data_resource_cannot_feed_analysis_node_directly() {
    let draft = super::draft::refresh_readiness(MethodDraft {
        schema_version: 1,
        id: "draft-data-analysis".into(),
        title: "Bad data analysis".into(),
        objective: "Prevent raw datasets from being modeled as analysis source nodes".into(),
        lifecycle: MethodLifecycleState::Drafting,
        resources: vec![MethodDraftResource {
            id: "dataset".into(),
            kind: "data".into(),
            label: "Verb dataset".into(),
            status: "attached".into(),
            path: Some("100_Verben.jsonl".into()),
            reference: None,
            consumed_by: vec!["sample_records".into()],
        }],
        nodes: vec![
            MethodDraftNode {
                id: "sample_records".into(),
                label: "Randomly sample records".into(),
                node_type: "analysis".into(),
                status: "ready".into(),
                config: serde_json::json!({}),
            },
            MethodDraftNode {
                id: "generate".into(),
                label: "Generate flash cards".into(),
                node_type: "inference".into(),
                status: "ready".into(),
                config: serde_json::json!({}),
            },
        ],
        edges: vec![MethodDraftEdge { from: "sample_records".into(), to: "generate".into() }],
        parameters: serde_json::json!({}),
        provider_config: serde_json::json!({}),
        outputs: vec![],
        metadata: serde_json::json!({}),
        readiness: MethodDraftReadiness {
            status: MethodLifecycleState::Drafting,
            blockers: vec![],
            warnings: vec![],
        },
    });

    assert!(draft.readiness.blockers.iter().any(|blocker| {
        blocker.code == "resource_node_kind_mismatch"
            && blocker.node_id.as_deref() == Some("sample_records")
            && blocker.resource_id.as_deref() == Some("dataset")
    }));
}

#[test]
fn api_key_resource_uses_reference_without_persisting_value() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-api-key-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    fs::write(
        temp.join(".nightshift/config.json"),
        r#"{ "apiKeys": { "openai.primary": "sk-test" } }"#,
    )
    .unwrap();
    create_draft_for_root(
        &temp,
        CreateMethodDraftInput {
            title: Some("API key draft".into()),
            objective: Some("Reference configured API keys".into()),
        },
    )
    .unwrap();
    super::draft::replace_draft_graph_for_root(
        &temp,
        ReplaceMethodDraftGraphInput {
            nodes: vec![MethodDraftNode {
                id: "generate".into(),
                label: "Generate".into(),
                node_type: "inference".into(),
                status: "draft".into(),
                config: serde_json::json!({}),
            }],
            edges: vec![],
            resources: Some(vec![]),
        },
    )
    .unwrap();

    let draft = resolve_api_key_resource_for_root(
        &temp,
        ResolveApiKeyResourceInput {
            id: "openai_key".into(),
            api_key_id: "openai.primary".into(),
            label: Some("OpenAI key".into()),
            consumed_by: vec!["generate".into()],
        },
    )
    .unwrap();

    assert_eq!(draft.resources[0].kind, "api_key");
    assert_eq!(draft.resources[0].reference.as_deref(), Some("openai.primary"));
    assert_eq!(draft.resources[0].path, None);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn nightshift_config_loads_provider_profiles_with_api_keys() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-config-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    fs::write(
        temp.join(".nightshift/config.json"),
        r#"{
          "providerProfiles": {
            "openai": {
              "provider": "OpenAI",
              "baseUrl": "https://api.openai.com/v1",
              "model": "gpt-test",
              "apiKey": "sk-test"
            }
          },
          "apiKeys": { "openai.primary": "sk-test" },
          "modelDefaults": { "providerProfile": "openai", "model": "gpt-test" }
        }"#,
    )
    .unwrap();

    let config = load_nightshift_config(&temp).unwrap();
    let profile = resolve_provider_profile(&config, "openai").unwrap();
    let default_profile = resolve_default_provider_profile(&config).unwrap().unwrap();

    assert_eq!(config.model_defaults.provider_profile.as_deref(), Some("openai"));
    assert_eq!(profile.api_key.as_deref(), Some("sk-test"));
    assert!(resolve_api_key_id(&config, "openai.primary").is_ok());
    assert_eq!(default_profile.model.as_deref(), Some("gpt-test"));
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

#[tokio::test]
async fn save_method_updates_existing_method_id_in_place() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-resave-test-{}", Uuid::new_v4()));
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

    let first = save_method_to_project(&db, &temp, method.clone()).await.unwrap();
    method.title = "Renamed edge method".into();
    let second = save_method_to_project(&db, &temp, method).await.unwrap();
    let listed = sqlx::query_as::<_, MethodSummary>(
        "SELECT id, title, content_hash, folder_path, created_at FROM methods",
    )
    .fetch_all(&db.pool())
    .await
    .unwrap();
    let manifest = read_manifest(&PathBuf::from(&second.folder_path)).unwrap();

    assert_eq!(first.id, "edge-method");
    assert_eq!(second.id, "edge-method");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title, "Renamed edge method");
    assert_eq!(manifest.title, "Renamed edge method");
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
fn method_graph_execution_plan_preserves_workflow_dependencies() {
    let mut method = sample_method();
    method.workflow.nodes = vec![
        MethodWorkflowNode {
            id: "aggregate".into(),
            node_type: "aggregate".into(),
            depends_on: vec!["eval".into()],
            config: serde_yaml::Value::Null,
        },
        MethodWorkflowNode {
            id: "generate".into(),
            node_type: "inference".into(),
            depends_on: vec![],
            config: serde_yaml::Value::Null,
        },
        MethodWorkflowNode {
            id: "eval".into(),
            node_type: "eval".into(),
            depends_on: vec!["generate".into()],
            config: serde_yaml::Value::Null,
        },
        MethodWorkflowNode {
            id: "summary".into(),
            node_type: "analysis".into(),
            depends_on: vec!["eval".into(), "aggregate".into()],
            config: serde_yaml::Value::Null,
        },
    ];

    let (task_ids, edges) = method_graph_execution_plan(&method.workflow.nodes).unwrap();

    assert_eq!(task_ids, vec!["generate", "eval", "aggregate", "summary"]);
    assert_eq!(
        edges,
        vec![
            ("generate".to_string(), "eval".to_string()),
            ("eval".to_string(), "aggregate".to_string()),
            ("eval".to_string(), "summary".to_string()),
            ("aggregate".to_string(), "summary".to_string())
        ]
    );
}

#[test]
fn method_graph_execution_plan_rejects_cycles() {
    let mut method = sample_method();
    method.workflow.nodes[0].depends_on = vec!["aggregate".into()];

    let err = method_graph_execution_plan(&method.workflow.nodes).unwrap_err();

    assert_eq!(err, "method.workflow could not be ordered");
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

#[test]
fn preflight_accepts_model_sweep_values_for_inference() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-preflight-sweep-test-{}", Uuid::new_v4()));
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
    method.parameters =
        serde_yaml::from_str("model_values:\n  - bonsai-8b\n  - qwen3.5-4b\n").unwrap();

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
