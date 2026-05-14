use super::*;

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
