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
fn validate_method_rejects_secret_values() {
    let mut method = sample_method();
    method.provider = serde_yaml::from_str("api_key: sk-test").unwrap();

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("secret-like"), "got: {err}");
}
