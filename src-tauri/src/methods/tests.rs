use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use uuid::Uuid;

use crate::database::DatabaseState;

use super::config::{
    load_nightshift_config, model_values, resolve_api_key_id, resolve_default_provider_profile,
    resolve_provider_profile,
};
use super::draft::{
    attach_resource_for_root, create_draft_for_root, default_draft, get_current_draft_for_root,
    method_document_for_save, resolve_api_key_resource_for_root,
    update_draft_execution_config_for_root, validate_graph,
};
use super::execution::{
    create_inference_job_for_node, create_sample_job_for_node, create_transform_job_for_node,
    insert_artifact, insert_execution, read_method_artifact_from_db, run_aggregate_agent,
    topological_nodes,
};
use super::model::*;
use super::preflight::preflight_method_for_root;
use super::storage::{
    freeze_files, read_manifest, read_method_document, save_method_to_project,
    write_method_document,
};
use super::validation::validate_method;

fn sample_method() -> MethodDocument {
    MethodDocument {
        schema_version: 1,
        id: "edge-method".into(),
        title: "Edge method".into(),
        objective: "Compare local models".into(),
        resources: vec![MethodResource {
            id: "prompt".into(),
            kind: "prompt".into(),
            label: "Prompt".into(),
            path: Some("prompts/main.jinja2".into()),
            reference: None,
            consumed_by: vec!["generate".into()],
        }],
        workflow: MethodWorkflow {
            nodes: vec![
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    depends_on: vec![],
                    config: serde_json::Value::Null,
                },
                MethodWorkflowNode {
                    id: "aggregate".into(),
                    label: "Aggregate".into(),
                    node_type: "aggregate".into(),
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

fn method_resource(id: &str, kind: &str, path: &str) -> MethodResource {
    MethodResource {
        id: id.into(),
        kind: kind.into(),
        label: id.into(),
        path: Some(path.into()),
        reference: None,
        consumed_by: vec![],
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

    assert_eq!(draft.schema_version, 1);
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
            depends_on: vec!["b".into()],
            config: serde_json::json!({}),
        },
        MethodWorkflowNode {
            id: "b".into(),
            label: "B".into(),
            node_type: "eval".into(),
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
    assert_eq!(super::draft::derive_readiness(&persisted).status, MethodLifecycleState::Drafting);
    let yaml_path = temp.join(".nightshift/current_method_draft.yaml");
    let yaml = fs::read_to_string(&yaml_path).unwrap();
    assert!(yaml.contains("schema_version:"), "got: {yaml}");
    assert!(yaml.contains("provider:"), "got: {yaml}");
    assert!(!yaml.contains("schemaVersion"), "got: {yaml}");
    assert!(!yaml.contains("providerConfig"), "got: {yaml}");
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
            workflow: MethodWorkflow {
                nodes: vec![MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    depends_on: vec![],
                    config: serde_json::json!({}),
                }],
            },
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
    assert_eq!(draft.resources[0].consumed_by, vec!["generate"]);
    let yaml = fs::read_to_string(temp.join(".nightshift/current_method_draft.yaml")).unwrap();
    assert!(yaml.contains("consumed_by:"), "got: {yaml}");
    assert!(!yaml.contains("consumedBy"), "got: {yaml}");
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
    assert_eq!(draft.resources[0].path.as_deref(), Some("schemas/out.json"));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn named_file_resource_with_path_is_not_reported_missing() {
    let draft = MethodDocument {
        schema_version: 1,
        id: "draft-resource-status".into(),
        title: "Resource status".into(),
        objective: "Keep named resource bindings from duplicating missing blockers".into(),
        resources: vec![MethodResource {
            id: "data".into(),
            kind: "data".into(),
            label: "Verb dataset".into(),
            path: Some("100_Verben.jsonl".into()),
            reference: None,
            consumed_by: vec!["generate".into()],
        }],
        workflow: MethodWorkflow {
            nodes: vec![MethodWorkflowNode {
                id: "generate".into(),
                label: "Generate".into(),
                node_type: "inference".into(),
                depends_on: vec![],
                config: serde_json::json!({}),
            }],
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
fn ready_draft_clones_to_freezable_method_document() {
    let draft = MethodDocument {
        schema_version: 1,
        id: "draft-1".into(),
        title: "Edge Model Flash-Card Accuracy at 98%".into(),
        objective: "Measure edge model flash-card accuracy.".into(),
        resources: vec![
            MethodResource {
                id: "prompt".into(),
                kind: "prompt".into(),
                label: "Prompt".into(),
                path: Some("flash_cards/flash_card_prompt.jinja2".into()),
                reference: None,
                consumed_by: vec!["generate".into()],
            },
            MethodResource {
                id: "schema".into(),
                kind: "json_schema".into(),
                label: "Schema".into(),
                path: Some("flash_cards/flash_card.schema.json".into()),
                reference: None,
                consumed_by: vec!["generate".into()],
            },
        ],
        workflow: MethodWorkflow {
            nodes: vec![
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    depends_on: vec![],
                    config: serde_json::json!({ "output_mode": "JSON Schema" }),
                },
                MethodWorkflowNode {
                    id: "analysis".into(),
                    label: "Analyze".into(),
                    node_type: "analysis".into(),
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
    assert_eq!(method.resources[0].kind, "prompt");
    assert_eq!(method.resources[1].kind, "json_schema");
    assert_eq!(method.workflow.nodes[1].depends_on, vec!["generate"]);
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
        schema_version: 1,
        id: "draft-data-analysis".into(),
        title: "Bad data analysis".into(),
        objective: "Prevent raw datasets from being modeled as analysis source nodes".into(),
        resources: vec![MethodResource {
            id: "dataset".into(),
            kind: "data".into(),
            label: "Verb dataset".into(),
            path: Some("100_Verben.jsonl".into()),
            reference: None,
            consumed_by: vec!["sample_records".into()],
        }],
        workflow: MethodWorkflow {
            nodes: vec![
                MethodWorkflowNode {
                    id: "sample_records".into(),
                    label: "Randomly sample records".into(),
                    node_type: "analysis".into(),
                    depends_on: vec![],
                    config: serde_json::json!({}),
                },
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate flash cards".into(),
                    node_type: "inference".into(),
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
        schema_version: 1,
        id: "sample-then-infer".into(),
        title: "Sample then infer".into(),
        objective: "Share a fixed sample".into(),
        resources: vec![
            MethodResource {
                id: "prompt".into(),
                kind: "prompt".into(),
                label: "Prompt".into(),
                path: Some("prompts/main.jinja2".into()),
                reference: None,
                consumed_by: vec!["infer_a".into(), "infer_b".into()],
            },
            MethodResource {
                id: "data".into(),
                kind: "data".into(),
                label: "Data".into(),
                path: Some("data/examples.jsonl".into()),
                reference: None,
                consumed_by: vec!["sample_records".into()],
            },
        ],
        workflow: MethodWorkflow {
            nodes: vec![
                MethodWorkflowNode {
                    id: "sample_records".into(),
                    label: "Sample records".into(),
                    node_type: "sample".into(),
                    depends_on: vec![],
                    config: serde_json::json!({ "samples": 1, "strategy": "single" }),
                },
                MethodWorkflowNode {
                    id: "infer_a".into(),
                    label: "Infer A".into(),
                    node_type: "inference".into(),
                    depends_on: vec!["sample_records".into()],
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
            workflow: MethodWorkflow {
                nodes: vec![MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    depends_on: vec![],
                    config: serde_json::json!({}),
                }],
            },
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
    method.resources[0].path = Some("files/already-frozen.jinja2".into());

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

    assert!(method.resources[0].path.as_deref().unwrap().starts_with("files/"));
    assert!(dest.join(method.resources[0].path.as_deref().unwrap()).is_file());
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
    method.resources.push(method_resource("data", "data", "data/examples.jsonl"));
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
    assert!(manifest.resources[0].path.as_deref().unwrap().starts_with("files/"));
    assert!(PathBuf::from(&summary.folder_path)
        .join(manifest.resources[0].path.as_deref().unwrap())
        .is_file());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn method_document_round_trips_through_draft_and_saved_paths() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-roundtrip-test-{}", Uuid::new_v4()));
    let draft_path = temp.join(".nightshift/current_method_draft.yaml");
    let saved_path = temp.join("methods/edge-method/method.yaml");
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

#[tokio::test]
async fn draft_and_saved_yaml_use_same_canonical_shape_without_derived_state() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-shape-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::create_dir_all(temp.join("data")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let mut method = sample_method();
    method.resources.push(method_resource("data", "data", "data/examples.jsonl"));
    method.provider = serde_yaml::from_str("model: bonsai-8b").unwrap();
    method.parameters = serde_yaml::from_str("samples: 2").unwrap();
    let draft_path = temp.join(".nightshift/current_method_draft.yaml");

    write_method_document(&draft_path, &method).unwrap();
    let summary = save_method_to_project(&db, &temp, method).await.unwrap();
    let saved_path = PathBuf::from(summary.folder_path).join("method.yaml");
    let draft_keys = yaml_top_level_keys(&draft_path);
    let saved_keys = yaml_top_level_keys(&saved_path);

    assert_eq!(draft_keys, saved_keys);
    for forbidden in ["readiness", "lifecycle", "edges", "files", "schemaVersion", "providerConfig"]
    {
        assert!(!draft_keys.contains(forbidden), "draft persisted {forbidden}");
        assert!(!saved_keys.contains(forbidden), "saved Method persisted {forbidden}");
    }
    let saved = fs::read_to_string(&saved_path).unwrap();
    assert!(saved.contains("resources:"), "got: {saved}");
    assert!(saved.contains("workflow:"), "got: {saved}");
    assert!(saved.contains("depends_on:"), "got: {saved}");
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
    method.resources.push(method_resource("data", "data", "data/examples.jsonl"));
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
fn preflight_reports_missing_required_files() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-preflight-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let mut method = sample_method();
    method.resources = vec![];

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
    method.resources.push(method_resource("data", "data", "data/examples.jsonl"));
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
    method.resources.push(method_resource("data", "data", "data/examples.jsonl"));
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
    method.resources.push(method_resource("data", "data", "data/examples.jsonl"));
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
        schema_version: 1,
        id: "node-prompt-method".into(),
        title: "Node prompt method".into(),
        objective: "Use node-specific prompts".into(),
        resources: vec![
            MethodResource {
                id: "generate_prompt".into(),
                kind: "prompt".into(),
                label: "Generation prompt".into(),
                path: Some("prompts/generate.jinja2".into()),
                reference: None,
                consumed_by: vec!["generate".into()],
            },
            MethodResource {
                id: "judge_prompt".into(),
                kind: "prompt".into(),
                label: "Judge prompt".into(),
                path: Some("prompts/judge.jinja2".into()),
                reference: None,
                consumed_by: vec!["judge".into()],
            },
            MethodResource {
                id: "data".into(),
                kind: "data".into(),
                label: "Data".into(),
                path: Some("data/examples.jsonl".into()),
                reference: None,
                consumed_by: vec!["generate".into()],
            },
        ],
        workflow: MethodWorkflow {
            nodes: vec![
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    depends_on: vec![],
                    config: serde_json::Value::Null,
                },
                MethodWorkflowNode {
                    id: "judge".into(),
                    label: "Judge".into(),
                    node_type: "inference".into(),
                    depends_on: vec!["generate".into()],
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

    let summary = save_method_to_project(&db, &temp, method).await.unwrap();
    let frozen = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();
    let execution_id = insert_execution(&db, &frozen, &summary.content_hash).await.unwrap();
    let judge_node = frozen.workflow.nodes.iter().find(|node| node.id == "judge").unwrap();

    let job_id = create_inference_job_for_node(
        &db,
        &frozen,
        judge_node,
        execution_id,
        Some("collection:42".into()),
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert!(job.prompt_file.starts_with("methods/node-prompt-method/files/"));
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
    method.resources.push(method_resource("data", "data", "data/examples.jsonl"));
    method.provider = serde_json::json!({
        "provider": "Local",
        "server_url": "http://localhost:1234",
        "model": "qwen-test"
    });
    method.parameters = serde_json::json!({
        "samples": 99,
        "strategy": "random"
    });
    let summary = save_method_to_project(&db, &temp, method).await.unwrap();
    let frozen = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();
    let execution_id = insert_execution(&db, &frozen, &summary.content_hash).await.unwrap();

    let job_id = create_inference_job_for_node(
        &db,
        &frozen,
        &frozen.workflow.nodes[0],
        execution_id,
        Some("collection:42".into()),
        None,
        None,
    )
    .await
    .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert_eq!(job.data_source, "collection:42");
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
        schema_version: 1,
        id: "sample-method".into(),
        title: "Sample method".into(),
        objective: "Share one sample".into(),
        resources: vec![method_resource("data", "data", "data/examples.jsonl")],
        workflow: MethodWorkflow {
            nodes: vec![MethodWorkflowNode {
                id: "sample_records".into(),
                label: "Sample records".into(),
                node_type: "sample".into(),
                depends_on: vec![],
                config: serde_json::json!({ "samples": 2, "strategy": "random" }),
            }],
        },
        parameters: serde_json::Value::Null,
        provider: serde_json::Value::Null,
        outputs: vec![],
        metadata: serde_json::Value::Null,
    };
    let summary = save_method_to_project(&db, &temp, method).await.unwrap();
    let frozen = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();
    let execution_id = insert_execution(&db, &frozen, &summary.content_hash).await.unwrap();

    let job_id =
        create_sample_job_for_node(&db, &frozen, &frozen.workflow.nodes[0], execution_id, None)
            .await
            .unwrap();
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

    assert_eq!(job.job_type, "sample");
    assert!(job.data_source.starts_with("methods/sample-method/files/"));
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
    method.resources = vec![
        method_resource("data", "data", "data/examples.jsonl"),
        method_resource("script", "eval_script", "scripts/score.js"),
    ];
    method.workflow.nodes = vec![MethodWorkflowNode {
        id: "score".into(),
        label: "Score".into(),
        node_type: "transform".into(),
        depends_on: vec![],
        config: serde_json::Value::Null,
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
        label: "Aggregate".into(),
        node_type: "aggregate".into(),
        depends_on: vec!["score".into()],
        config: serde_json::Value::Null,
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
