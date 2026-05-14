use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use uuid::Uuid;

use crate::database::DatabaseState;

use super::config::{
    load_nightshift_config, model_values, resolve_api_key_id, resolve_default_provider_profile,
    resolve_provider_profile,
};
use super::draft::{
    create_draft_for_root, default_draft, get_current_draft_for_root, method_document_for_save,
    update_draft_execution_config_for_root, validate_graph,
};
use super::execution::{
    analysis_report_relative_path, analysis_report_repair_prompt, append_jsonl,
    create_inference_job_for_node, create_sample_job_for_node, create_transform_job_for_node,
    insert_analysis_report_artifact, insert_artifact, insert_execution,
    read_method_artifact_from_db, run_analysis_sql_query, topological_nodes, upstream_job_sources,
    validate_analysis_sql,
};
use super::model::*;
use super::preflight::preflight_method_for_root;
use super::storage::{freeze_files, read_method_document, write_method_document};
use super::validation::validate_method;

fn sample_method() -> MethodDocument {
    MethodDocument {
        schema_version: 2,
        id: "edge-method".into(),
        title: "Edge method".into(),
        objective: "Compare local models".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("prompt", "prompt", "prompts/main.jinja2"),
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["prompt".into()],
                    config: serde_json::Value::Null,
                },
                MethodWorkflowNode {
                    id: "analysis".into(),
                    label: "Analyze".into(),
                    node_type: "analysis".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["generate".into()],
                    config: serde_json::Value::Null,
                },
            ],
        },
        parameters: serde_json::Value::Null,
        provider: serde_json::Value::Null,
        outputs: vec![],
        metadata: serde_json::Value::Null,
    }
}

async fn prepare_frozen_execution(
    db: &DatabaseState,
    root: &PathBuf,
    method: MethodDocument,
) -> (MethodDocument, i64) {
    let execution_id = insert_execution(db, &method, "test-hash").await.unwrap();
    let snapshot_dir =
        root.join(".nightshift").join("executions").join(execution_id.to_string()).join("snapshot");
    let mut frozen = method;
    freeze_files(&mut frozen, root, &snapshot_dir).unwrap();
    write_method_document(&snapshot_dir.join("method.yaml"), &frozen).unwrap();
    (frozen, execution_id)
}

fn method_resource(id: &str, kind: &str, path: &str) -> MethodWorkflowNode {
    MethodWorkflowNode {
        id: id.into(),
        node_type: "resource".into(),
        kind: Some(kind.into()),
        label: id.into(),
        path: Some(path.into()),
        reference: None,
        depends_on: vec![],
        config: serde_json::Value::Null,
    }
}

fn add_resource_dependency(
    method: &mut MethodDocument,
    resource: MethodWorkflowNode,
    consumer_id: &str,
) {
    let resource_id = resource.id.clone();
    method.workflow.nodes.insert(1, resource);
    if let Some(consumer) = method.workflow.nodes.iter_mut().find(|node| node.id == consumer_id) {
        if !consumer.depends_on.contains(&resource_id) {
            consumer.depends_on.push(resource_id);
        }
    }
}

fn yaml_top_level_keys(path: &PathBuf) -> HashSet<String> {
    let yaml = fs::read_to_string(path).unwrap();
    let value: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
    value.as_mapping().unwrap().keys().map(|key| key.as_str().unwrap().to_string()).collect()
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

    assert_eq!(draft.schema_version, 2);
    assert!(draft.id.starts_with("draft-"));
    assert_eq!(draft.title, "Untitled Method");
    let readiness = super::draft::derive_readiness(&draft);
    assert_eq!(readiness.status, MethodLifecycleState::Drafting);
    assert!(readiness.blockers.iter().any(|blocker| blocker.code == "missing_title"));
    assert!(readiness.blockers.iter().any(|blocker| blocker.code == "missing_objective"));
    assert!(readiness.blockers.iter().any(|blocker| blocker.code == "missing_nodes"));
}

#[test]
fn draft_graph_validation_rejects_unknown_edge_endpoints() {
    let nodes = vec![MethodWorkflowNode {
        id: "generate".into(),
        label: "Generate".into(),
        node_type: "inference".into(),
        kind: None,
        path: None,
        reference: None,
        depends_on: vec!["score".into()],
        config: serde_json::json!({}),
    }];

    let err = validate_graph(&nodes).unwrap_err();

    assert!(err.contains("unknown node 'score'"), "got: {err}");
}

#[test]
fn draft_graph_validation_rejects_cycles() {
    let nodes = vec![
        MethodWorkflowNode {
            id: "a".into(),
            label: "A".into(),
            node_type: "inference".into(),
            kind: None,
            path: None,
            reference: None,
            depends_on: vec!["b".into()],
            config: serde_json::json!({}),
        },
        MethodWorkflowNode {
            id: "b".into(),
            label: "B".into(),
            node_type: "eval".into(),
            kind: None,
            path: None,
            reference: None,
            depends_on: vec!["a".into()],
            config: serde_json::json!({}),
        },
    ];

    let err = validate_graph(&nodes).unwrap_err();

    assert!(err.contains("cycle"), "got: {err}");
}

#[test]
fn agent_tool_style_draft_creation_persists_current_draft() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-draft-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("methods")).unwrap();

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
    assert_eq!(super::draft::derive_readiness(&persisted).status, MethodLifecycleState::Drafting);
    let yaml_path = temp.join("methods/current.method.yaml");
    let yaml = fs::read_to_string(&yaml_path).unwrap();
    assert!(yaml.contains("schema_version:"), "got: {yaml}");
    assert!(yaml.contains("provider:"), "got: {yaml}");
    assert!(!yaml.contains("schemaVersion"), "got: {yaml}");
    assert!(!yaml.contains("providerConfig"), "got: {yaml}");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn resource_node_persists_as_graph_dependency() {
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
            workflow: MethodWorkflow {
                nodes: vec![
                    MethodWorkflowNode {
                        id: "main_prompt".into(),
                        label: "Main prompt".into(),
                        node_type: "resource".into(),
                        kind: Some("prompt".into()),
                        path: Some("prompts/main.md".into()),
                        reference: None,
                        depends_on: vec![],
                        config: serde_json::json!({}),
                    },
                    MethodWorkflowNode {
                        id: "generate".into(),
                        label: "Generate".into(),
                        node_type: "inference".into(),
                        kind: None,
                        path: None,
                        reference: None,
                        depends_on: vec!["main_prompt".into()],
                        config: serde_json::json!({}),
                    },
                ],
            },
        },
    )
    .unwrap();

    let draft = get_current_draft_for_root(&temp).unwrap().unwrap();
    assert_eq!(draft.workflow.nodes[0].path.as_deref(), Some("prompts/main.md"));
    assert_eq!(draft.workflow.nodes[1].depends_on, vec!["main_prompt"]);
    let yaml = fs::read_to_string(temp.join("methods/current.method.yaml")).unwrap();
    assert!(yaml.contains("type: resource"), "got: {yaml}");
    assert!(!yaml.contains("consumed_by"), "got: {yaml}");
    assert!(!yaml.contains("resources:"), "got: {yaml}");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn named_file_resource_with_path_is_not_reported_missing() {
    let draft = MethodDocument {
        schema_version: 2,
        id: "draft-resource-status".into(),
        title: "Resource status".into(),
        objective: "Keep named resource bindings from duplicating missing blockers".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("data", "data", "100_Verben.jsonl"),
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["data".into()],
                    config: serde_json::json!({}),
                },
            ],
        },
        parameters: serde_json::json!({}),
        provider: serde_json::json!({}),
        outputs: vec![],
        metadata: serde_json::json!({}),
    };

    assert!(!super::draft::derive_readiness(&draft)
        .blockers
        .iter()
        .any(|blocker| blocker.code == "missing_resource"));
}

#[test]
fn validate_method_rejects_resource_nodes_from_dependency_folders() {
    let mut method = sample_method();
    method.workflow.nodes[0].path = Some("node_modules/pkg/prompt.md".into());

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("dependency"), "got: {err}");
}

#[test]
fn ready_draft_clones_to_freezable_method_document() {
    let draft = MethodDocument {
        schema_version: 2,
        id: "draft-1".into(),
        title: "Edge Model Flash-Card Accuracy at 98%".into(),
        objective: "Measure edge model flash-card accuracy.".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("prompt", "prompt", "flash_cards/flash_card_prompt.jinja2"),
                method_resource("schema", "json_schema", "flash_cards/flash_card.schema.json"),
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["prompt".into(), "schema".into()],
                    config: serde_json::json!({ "output_mode": "JSON Schema" }),
                },
                MethodWorkflowNode {
                    id: "analysis".into(),
                    label: "Analyze".into(),
                    node_type: "analysis".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["generate".into()],
                    config: serde_json::json!({}),
                },
            ],
        },
        parameters: serde_json::json!({}),
        provider: serde_json::json!({ "model": "qwen-test" }),
        outputs: vec![],
        metadata: serde_json::json!({}),
    };

    let method = method_document_for_save(&draft).unwrap();

    assert_eq!(method.id, "draft-1");
    assert_eq!(method.workflow.nodes[0].kind.as_deref(), Some("prompt"));
    assert_eq!(method.workflow.nodes[1].kind.as_deref(), Some("json_schema"));
    assert_eq!(method.workflow.nodes[3].depends_on, vec!["generate"]);
    assert_eq!(method.provider.get("model").and_then(serde_json::Value::as_str), Some("qwen-test"));
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
            provider: Some(serde_json::json!({
                "model": "qwen-test",
                "server_url": "http://localhost:11434"
            })),
            parameters: Some(serde_json::json!({
                "model_values": ["bonsai-8b", "qwen3.5-4b"],
                "max_tokens": 2000,
                "samples": 2
            })),
        },
    )
    .unwrap();

    assert_eq!(draft.provider.get("model").and_then(serde_json::Value::as_str), Some("qwen-test"));
    assert_eq!(
        draft.provider.get("server_url").and_then(serde_json::Value::as_str),
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
    let draft = MethodDocument {
        schema_version: 2,
        id: "draft-data-analysis".into(),
        title: "Bad data analysis".into(),
        objective: "Prevent raw datasets from being modeled as analysis source nodes".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("dataset", "data", "100_Verben.jsonl"),
                MethodWorkflowNode {
                    id: "sample_records".into(),
                    label: "Randomly sample records".into(),
                    node_type: "analysis".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["dataset".into()],
                    config: serde_json::json!({}),
                },
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate flash cards".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["sample_records".into()],
                    config: serde_json::json!({}),
                },
            ],
        },
        parameters: serde_json::json!({}),
        provider: serde_json::json!({}),
        outputs: vec![],
        metadata: serde_json::json!({}),
    };

    assert!(super::draft::derive_readiness(&draft).blockers.iter().any(|blocker| {
        blocker.code == "resource_node_kind_mismatch"
            && blocker.node_id.as_deref() == Some("sample_records")
            && blocker.resource_id.as_deref() == Some("dataset")
    }));
}

#[test]
fn sample_node_allows_inference_without_direct_data_resource() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-preflight-sample-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let method = MethodDocument {
        schema_version: 2,
        id: "sample-then-infer".into(),
        title: "Sample then infer".into(),
        objective: "Share a fixed sample".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("prompt", "prompt", "prompts/main.jinja2"),
                method_resource("data", "data", "data/examples.jsonl"),
                MethodWorkflowNode {
                    id: "sample_records".into(),
                    label: "Sample records".into(),
                    node_type: "sample".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["data".into()],
                    config: serde_json::json!({ "samples": 1, "strategy": "single" }),
                },
                MethodWorkflowNode {
                    id: "infer_a".into(),
                    label: "Infer A".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["sample_records".into(), "prompt".into()],
                    config: serde_json::Value::Null,
                },
            ],
        },
        parameters: serde_json::Value::Null,
        provider: serde_json::json!({ "model": "qwen-test" }),
        outputs: vec![],
        metadata: serde_json::Value::Null,
    };

    let result = preflight_method_for_root(&method, &temp);

    assert!(
        !result.blockers.iter().any(|blocker| blocker.message.contains("data source")),
        "got blockers: {:?}",
        result.blockers
    );
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn api_key_resource_uses_reference_without_persisting_value() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-api-key-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("methods")).unwrap();
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    fs::write(
        temp.join(".nightshift/config.json"),
        r#"{ "apiKeys": { "openai.primary": "OPENAI_API_KEY" } }"#,
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
            workflow: MethodWorkflow {
                nodes: vec![
                    MethodWorkflowNode {
                        id: "openai_key".into(),
                        label: "OpenAI key".into(),
                        node_type: "resource".into(),
                        kind: Some("api_key".into()),
                        path: None,
                        reference: Some("openai.primary".into()),
                        depends_on: vec![],
                        config: serde_json::json!({}),
                    },
                    MethodWorkflowNode {
                        id: "generate".into(),
                        label: "Generate".into(),
                        node_type: "inference".into(),
                        kind: None,
                        path: None,
                        reference: None,
                        depends_on: vec!["openai_key".into()],
                        config: serde_json::json!({}),
                    },
                ],
            },
        },
    )
    .unwrap();

    let draft = get_current_draft_for_root(&temp).unwrap().unwrap();

    assert_eq!(draft.workflow.nodes[0].kind.as_deref(), Some("api_key"));
    assert_eq!(draft.workflow.nodes[0].reference.as_deref(), Some("openai.primary"));
    assert_eq!(draft.workflow.nodes[0].path, None);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn nightshift_config_loads_provider_profiles_with_api_key_env_vars() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-config-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("methods")).unwrap();
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    fs::write(
        temp.join(".nightshift/config.json"),
        r#"{
          "providerProfiles": {
            "openai": {
              "provider": "OpenAI",
              "baseUrl": "https://api.openai.com/v1",
              "model": "gpt-test",
              "apiKey": "OPENAI_API_KEY"
            }
          },
          "apiKeys": { "openai.primary": "OPENAI_API_KEY" },
          "modelDefaults": { "providerProfile": "openai", "model": "gpt-test" }
        }"#,
    )
    .unwrap();

    let config = load_nightshift_config(&temp).unwrap();
    let profile = resolve_provider_profile(&config, "openai").unwrap();
    let default_profile = resolve_default_provider_profile(&config).unwrap().unwrap();

    assert_eq!(config.model_defaults.provider_profile.as_deref(), Some("openai"));
    assert_eq!(profile.api_key.as_deref(), Some("OPENAI_API_KEY"));
    assert!(resolve_api_key_id(&config, "openai.primary").is_ok());
    assert_eq!(default_profile.model.as_deref(), Some("gpt-test"));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn nightshift_config_rejects_file_stored_api_key_values() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-config-secret-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("methods")).unwrap();
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    fs::write(
        temp.join(".nightshift/config.json"),
        r#"{ "apiKeys": { "openai.primary": "sk-test" } }"#,
    )
    .unwrap();

    let err = load_nightshift_config(&temp).unwrap_err();

    assert!(err.contains("secret-like"), "got: {err}");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn validate_method_rejects_cycles() {
    let mut method = sample_method();
    method.workflow.nodes[1].depends_on = vec!["analysis".into()];

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

#[test]
fn freeze_files_rewrites_to_content_addressed_paths() {
    let temp = std::env::temp_dir().join(format!("nightshift-method-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    let dest = temp.join(".nightshift/executions/1/snapshot");
    let mut method = sample_method();

    freeze_files(&mut method, &temp, &dest).unwrap();

    assert!(method.workflow.nodes[0].path.as_deref().unwrap().starts_with("files/"));
    assert!(dest.join(method.workflow.nodes[0].path.as_deref().unwrap()).is_file());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn method_document_round_trips_through_source_paths() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-roundtrip-test-{}", Uuid::new_v4()));
    let draft_path = temp.join("methods/current.method.yaml");
    let saved_path = temp.join("methods/edge.method.yaml");
    fs::create_dir_all(draft_path.parent().unwrap()).unwrap();
    fs::create_dir_all(saved_path.parent().unwrap()).unwrap();
    let method = sample_method();

    write_method_document(&draft_path, &method).unwrap();
    write_method_document(&saved_path, &method).unwrap();

    assert_eq!(read_method_document(&draft_path).unwrap(), method);
    assert_eq!(read_method_document(&saved_path).unwrap(), method);
    assert_eq!(yaml_top_level_keys(&draft_path), yaml_top_level_keys(&saved_path));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn topological_nodes_orders_dependencies_first() {
    let method = sample_method();

    let ordered = topological_nodes(&method.workflow.nodes).unwrap();

    assert_eq!(
        ordered.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
        vec!["generate", "analysis",]
    );
}

#[test]
fn preflight_reports_missing_required_files() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-preflight-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let mut method = sample_method();
    method.workflow.nodes.retain(|node| !node.is_resource());
    method.workflow.nodes[0].depends_on.clear();

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
    add_resource_dependency(
        &mut method,
        method_resource("data", "data", "data/examples.jsonl"),
        "generate",
    );
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
    add_resource_dependency(
        &mut method,
        method_resource("data", "data", "data/examples.jsonl"),
        "generate",
    );
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

#[test]
fn method_tool_schema_exposes_analysis_without_aggregate() {
    let tools = super::method_function_tools();
    let replace_graph = tools
        .iter()
        .find(|tool| {
            tool.get("name").and_then(serde_json::Value::as_str)
                == Some("replace_method_draft_graph")
        })
        .unwrap();
    let enum_values = replace_graph["parameters"]["properties"]["workflow"]["properties"]["nodes"]
        ["items"]["properties"]["type"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();

    assert!(enum_values.contains(&"analysis"));
    assert!(!enum_values.contains(&"output_file"));
    assert!(!enum_values.contains(&"aggregate"));
    assert!(replace_graph["parameters"]["properties"]["workflow"]["properties"]["nodes"]["items"]
        ["properties"]["config"]["properties"]
        .as_object()
        .unwrap()
        .get("output_file")
        .is_none());
    let config_properties = replace_graph["parameters"]["properties"]["workflow"]["properties"]
        ["nodes"]["items"]["properties"]["config"]["properties"]
        .as_object()
        .unwrap();
    for key in ["samples", "strategy", "model", "server_url", "prompt_file", "json_schema_file"] {
        assert!(config_properties.contains_key(key), "missing config key {key}");
    }
}

#[test]
fn aggregate_draft_nodes_are_normalized_to_analysis() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-normalize-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    create_draft_for_root(
        &temp,
        CreateMethodDraftInput {
            title: Some("Normalize aggregate".into()),
            objective: Some("Migrate aggregate draft nodes".into()),
        },
    )
    .unwrap();

    let draft = super::draft::replace_draft_graph_for_root(
        &temp,
        ReplaceMethodDraftGraphInput {
            workflow: MethodWorkflow {
                nodes: vec![MethodWorkflowNode {
                    id: "aggregate".into(),
                    label: "Aggregate".into(),
                    node_type: "aggregate".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec![],
                    config: serde_json::Value::Null,
                }],
            },
        },
    )
    .unwrap();

    assert_eq!(draft.workflow.nodes[0].node_type, "analysis");
    assert_eq!(
        get_current_draft_for_root(&temp).unwrap().unwrap().workflow.nodes[0].node_type,
        "analysis"
    );
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn analysis_sql_guardrails_allow_only_read_queries() {
    assert!(validate_analysis_sql("SELECT * FROM method_execution_outputs").is_ok());
    assert!(validate_analysis_sql("WITH rows AS (SELECT 1 AS n) SELECT n FROM rows;").is_ok());
    for sql in [
        "INSERT INTO method_execution_outputs VALUES (1)",
        "SELECT 1; SELECT 2",
        "PRAGMA table_info(method_execution_outputs)",
        "SELECT 1 -- hidden",
        "/* hidden */ SELECT 1",
        "WITH deleted AS (DELETE FROM method_execution_outputs RETURNING *) SELECT * FROM deleted",
    ] {
        assert!(validate_analysis_sql(sql).is_err(), "query should be rejected: {sql}");
    }
}

#[tokio::test]
async fn analysis_sql_query_applies_row_limit() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-analysis-sql-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();

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
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
    for item in [serde_json::json!({ "pass": true }), serde_json::json!({ "pass": false })] {
        sqlx::query(
            "INSERT INTO method_execution_outputs (execution_id, node_id, job_id, data) VALUES (?1, 'analysis', ?2, ?3)",
        )
            .bind(execution_id)
            .bind(job_id)
            .bind(item)
            .execute(&db.pool())
            .await
            .unwrap();
    }

    let result =
        run_analysis_sql_query(&db, "SELECT id, data FROM method_execution_outputs ORDER BY id", 1)
            .await
            .unwrap();

    assert_eq!(result["row_count"], 1);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["rows"][0]["data"]["pass"], true);
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn analysis_report_artifact_requires_required_sections() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-report-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
    let report = r#"# Experiment Report

## Abstract
Summary.

## Method Summary
Method.

## Data Summaries
Data.

## Discussion Points
Discussion.

## Caveats
Caveats.

## Conclusion
Conclusion.
"#;

    let mut method = sample_method();
    method.id = "report-method".into();
    let node = MethodWorkflowNode {
        id: "analysis".into(),
        label: "Analyze".into(),
        node_type: "analysis".into(),
        kind: None,
        path: None,
        reference: None,
        depends_on: vec![],
        config: serde_json::Value::Null,
    };

    let output_ref =
        insert_analysis_report_artifact(&db, &method, execution_id, &node, report).await.unwrap();
    let bad_report = report.replace("## Caveats", "## Limitations");

    assert!(output_ref.starts_with("file:"));
    assert!(temp
        .join(".nightshift/executions")
        .join(execution_id.to_string())
        .join("files")
        .join("analysis")
        .join("analysis.md")
        .is_file());
    assert!(insert_analysis_report_artifact(&db, &method, execution_id, &node, &bad_report)
        .await
        .is_err());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn analysis_node_path_controls_analysis_report_location() {
    let mut method = sample_method();
    method.id = "branch-method".into();
    let node = MethodWorkflowNode {
        id: "analyze_branch_a".into(),
        label: "Analyze branch A".into(),
        node_type: "analysis".into(),
        kind: None,
        path: Some("branch-a/report".into()),
        reference: None,
        depends_on: vec![],
        config: serde_json::json!({}),
    };

    let path = analysis_report_relative_path(&method, 42, &node).unwrap();

    assert_eq!(
        path.to_string_lossy().replace('\\', "/"),
        ".nightshift/executions/42/files/analyze_branch_a/branch-a/report.md"
    );
    assert!(!path.starts_with("methods/branch-method"));
}

#[test]
fn output_file_node_type_is_rejected() {
    let mut method = sample_method();
    method.workflow.nodes.push(MethodWorkflowNode {
        id: "report_file".into(),
        label: "Report file".into(),
        node_type: "output_file".into(),
        kind: None,
        path: Some("report.md".into()),
        reference: None,
        depends_on: vec!["analysis".into()],
        config: serde_json::json!({}),
    });

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("removed type 'output_file'"), "got: {err}");
}

#[test]
fn analysis_report_repair_prompt_requires_exact_headings() {
    let prompt = analysis_report_repair_prompt(
        "Analysis report is missing required section 'Abstract'",
        "# Abstract\nDraft",
    );

    for heading in [
        "## Abstract",
        "## Method Summary",
        "## Data Summaries",
        "## Discussion Points",
        "## Caveats",
        "## Conclusion",
    ] {
        assert!(prompt.contains(heading), "missing heading in prompt: {heading}");
    }
    assert!(prompt.contains("Prior draft"));
    assert!(prompt.contains("# Abstract\nDraft"));
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
        "SELECT id, execution_id, node_id, file_type, path, content_hash, created_at FROM method_execution_files WHERE execution_id = ?",
    )
    .bind(execution_id)
    .fetch_one(&db.pool())
    .await
    .unwrap();
    let content = read_method_artifact_from_db(&db, artifact.id).await.unwrap();

    assert_eq!(content, "# Analysis");
    assert_eq!(artifact.file_type, "inline_markdown");
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

#[test]
fn append_jsonl_writes_complete_lines_under_concurrent_calls() {
    use std::sync::{Arc, Barrier};

    let temp =
        std::env::temp_dir().join(format!("nightshift-jsonl-append-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let path = temp.join("log.jsonl");
    let barrier = Arc::new(Barrier::new(8));
    let handles = (0..8)
        .map(|index| {
            let barrier = Arc::clone(&barrier);
            let path = path.clone();
            std::thread::spawn(move || {
                barrier.wait();
                append_jsonl(&path, &serde_json::json!({ "index": index })).unwrap();
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        handle.join().unwrap();
    }

    let content = fs::read_to_string(&path).unwrap();
    let mut seen = content
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["index"].as_i64().unwrap()
        })
        .collect::<Vec<_>>();
    seen.sort();

    assert_eq!(seen, vec![0, 1, 2, 3, 4, 5, 6, 7]);
    fs::remove_dir_all(temp).unwrap();
}
