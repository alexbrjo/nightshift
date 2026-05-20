use super::*;

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
fn validate_method_rejects_eval_node_type() {
    let mut method = sample_method();
    method.workflow.nodes[1].node_type = "eval".into();

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("unsupported type 'eval'"), "got: {err}");
}

#[test]
fn validate_method_rejects_missing_resource_paths() {
    let mut method = sample_method();
    method.workflow.nodes[0].path = None;

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("must set path"), "got: {err}");
}

#[test]
fn validate_method_rejects_missing_api_key_reference() {
    let mut method = sample_method();
    method.workflow.nodes[0].kind = Some("api_key".into());
    method.workflow.nodes[0].path = None;
    method.workflow.nodes[0].reference = None;

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("must set reference"), "got: {err}");
}

#[test]
fn validate_method_rejects_secret_values() {
    let mut method = sample_method();
    method.provider = serde_yaml::from_str("api_key: sk-test").unwrap();

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("secret-like"), "got: {err}");
}

#[test]
fn validate_method_rejects_provider_alias_keys() {
    let mut method = sample_method();
    method.provider = serde_json::json!({
        "name": "Local",
        "base_url": "http://localhost:1234/v1",
        "model": "qwen-test"
    });

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("unsupported key"), "got: {err}");
    assert!(err.contains("provider.server_url"), "got: {err}");
}

#[test]
fn validate_method_rejects_json_schema_file_without_json_schema_output_mode() {
    let mut method = sample_method();
    method.workflow.nodes[1].config = serde_json::json!({
        "json_schema_file": "flash_card_schema"
    });

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("json_schema_file"), "got: {err}");
    assert!(err.contains("output_mode: JSON Schema"), "got: {err}");
}
