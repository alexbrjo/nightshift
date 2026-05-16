use super::*;

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
    let readiness = crate::methods::draft::derive_readiness(&draft);
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
            node_type: "transform".into(),
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
    assert_eq!(
        crate::methods::draft::derive_readiness(&persisted).status,
        MethodLifecycleState::Drafting
    );
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
    crate::methods::draft::replace_draft_graph_for_root(
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

    assert!(!crate::methods::draft::derive_readiness(&draft)
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

    assert!(crate::methods::draft::derive_readiness(&draft).blockers.iter().any(|blocker| {
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
    crate::methods::draft::replace_draft_graph_for_root(
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
