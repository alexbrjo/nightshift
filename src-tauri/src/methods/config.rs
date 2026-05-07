use std::fs;
use std::path::Path;

use super::model::{
    MethodFileRef, MethodManifest, MethodWorkflowNode, NightshiftConfig, ProviderProfile,
};

pub(crate) fn config_path(project_root: &Path) -> std::path::PathBuf {
    project_root.join(".nightshift").join("config.json")
}

pub(crate) fn load_nightshift_config(project_root: &Path) -> Result<NightshiftConfig, String> {
    let path = config_path(project_root);
    if !path.exists() {
        return Ok(NightshiftConfig::default());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read .nightshift/config.json: {}", e))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse .nightshift/config.json: {}", e))
}

pub(crate) fn resolve_provider_profile(
    config: &NightshiftConfig,
    id: &str,
) -> Result<ProviderProfile, String> {
    config
        .provider_profiles
        .get(id)
        .cloned()
        .ok_or_else(|| format!("Provider profile '{}' is not configured", id))
}

pub(crate) fn resolve_default_provider_profile(
    config: &NightshiftConfig,
) -> Result<Option<ProviderProfile>, String> {
    let Some(id) = config.model_defaults.provider_profile.as_deref() else {
        return Ok(None);
    };
    resolve_provider_profile(config, id).map(Some)
}

pub(crate) fn resolve_api_key_id(config: &NightshiftConfig, id: &str) -> Result<(), String> {
    if config.api_keys.contains_key(id)
        || config
            .provider_profiles
            .get(id)
            .and_then(|profile| profile.api_key.as_deref())
            .is_some_and(|value| !value.trim().is_empty())
    {
        Ok(())
    } else {
        Err(format!("API key '{}' is not configured in .nightshift/config.json", id))
    }
}

pub(crate) fn yaml_lookup<'a>(
    value: &'a serde_yaml::Value,
    key: &str,
) -> Option<&'a serde_yaml::Value> {
    value.as_mapping()?.get(serde_yaml::Value::String(key.to_string()))
}

pub(crate) fn yaml_string(value: Option<&serde_yaml::Value>) -> Option<String> {
    match value? {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

pub(crate) fn yaml_i32(value: Option<&serde_yaml::Value>) -> Option<i32> {
    match value? {
        serde_yaml::Value::Number(n) => n.as_i64().and_then(|v| i32::try_from(v).ok()),
        serde_yaml::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub(crate) fn yaml_f64(value: Option<&serde_yaml::Value>) -> Option<f64> {
    match value? {
        serde_yaml::Value::Number(n) => n.as_f64(),
        serde_yaml::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub(crate) fn config_string(
    node: &MethodWorkflowNode,
    method: &MethodManifest,
    key: &str,
    default: Option<&str>,
) -> Option<String> {
    yaml_string(yaml_lookup(&node.config, key))
        .or_else(|| yaml_string(yaml_lookup(&method.parameters, key)))
        .or_else(|| yaml_string(yaml_lookup(&method.provider, key)))
        .or_else(|| default.map(ToOwned::to_owned))
}

pub(crate) fn config_i32(
    node: &MethodWorkflowNode,
    method: &MethodManifest,
    key: &str,
    default: Option<i32>,
) -> Option<i32> {
    yaml_i32(yaml_lookup(&node.config, key))
        .or_else(|| yaml_i32(yaml_lookup(&method.parameters, key)))
        .or(default)
}

pub(crate) fn config_f64(
    node: &MethodWorkflowNode,
    method: &MethodManifest,
    key: &str,
) -> Option<f64> {
    yaml_f64(yaml_lookup(&node.config, key))
        .or_else(|| yaml_f64(yaml_lookup(&method.parameters, key)))
}

pub(crate) fn method_file_by_kind<'a>(
    method: &'a MethodManifest,
    kind: &str,
) -> Option<&'a MethodFileRef> {
    method.files.iter().find(|file| file.kind == kind)
}

pub(crate) fn resolve_configured_file(
    method: &MethodManifest,
    method_id: &str,
    configured: Option<String>,
    fallback_kind: &str,
) -> Result<String, String> {
    let file = configured
        .as_deref()
        .and_then(|id| method.files.iter().find(|file| file.id == id || file.path == id))
        .or_else(|| method_file_by_kind(method, fallback_kind))
        .ok_or_else(|| format!("No method file with kind '{}' is available", fallback_kind))?;
    if !file.path.starts_with("files/") {
        return Err(format!("Method file '{}' was not frozen", file.id));
    }
    Ok(format!("methods/{}/{}", method_id, file.path))
}

pub(crate) fn yaml_string_list(value: Option<&serde_yaml::Value>) -> Vec<String> {
    match value {
        Some(serde_yaml::Value::Sequence(items)) => {
            items.iter().filter_map(|item| yaml_string(Some(item))).collect()
        }
        Some(serde_yaml::Value::String(s)) => vec![s.clone()],
        _ => vec![],
    }
}

pub(crate) fn model_values(method: &MethodManifest) -> Vec<String> {
    yaml_string_list(yaml_lookup(&method.parameters, "model_values"))
}
