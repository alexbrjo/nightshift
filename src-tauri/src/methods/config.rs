use super::model::{MethodFileRef, MethodManifest, MethodWorkflowNode};

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
