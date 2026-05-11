use std::collections::{HashMap, HashSet};

use super::model::{MethodDocument, MethodWorkflowNode};
use super::paths::{require_nonempty, validate_method_id, validate_relative_path};

const SECRET_KEYS: &[&str] =
    &["api_key", "apikey", "password", "secret", "access_token", "refresh_token", "bearer_token"];

pub(crate) fn reject_secret_values(value: &serde_yaml::Value, path: &str) -> Result<(), String> {
    match value {
        serde_yaml::Value::Mapping(map) => {
            for (key, child) in map {
                let key_text = key.as_str().unwrap_or("").to_lowercase();
                let child_path = if path.is_empty() {
                    key_text.clone()
                } else {
                    format!("{}.{}", path, key_text)
                };
                if SECRET_KEYS.contains(&key_text.as_str()) && !key_text.ends_with("_ref") {
                    match child {
                        serde_yaml::Value::Null => {}
                        serde_yaml::Value::String(s) if s.trim().is_empty() => {}
                        _ => {
                            return Err(format!(
                                "Method contains a secret-like value at '{}'; store secrets in global settings and reference them by id",
                                child_path
                            ));
                        }
                    }
                }
                reject_secret_values(child, &child_path)?;
            }
        }
        serde_yaml::Value::Sequence(items) => {
            for (index, child) in items.iter().enumerate() {
                reject_secret_values(child, &format!("{}[{}]", path, index))?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn validate_method(method: &MethodDocument) -> Result<(), String> {
    if method.schema_version != 1 {
        return Err("method.schema_version must be 1".into());
    }
    validate_method_id(&method.id)?;
    require_nonempty("method.title", &method.title)?;

    let manifest_value =
        serde_yaml::to_value(method).map_err(|e| format!("Failed to inspect method: {}", e))?;
    reject_secret_values(&manifest_value, "")?;

    let mut resource_ids = HashSet::new();
    for resource in &method.resources {
        require_nonempty("method.resources[].id", &resource.id)?;
        require_nonempty("method.resources[].kind", &resource.kind)?;
        if !resource_ids.insert(resource.id.as_str()) {
            return Err(format!("method.resources id '{}' is duplicated", resource.id));
        }
        if let Some(path) = resource.path.as_deref() {
            if !path.starts_with("files/") {
                validate_relative_path(path)?;
            }
        }
    }

    if method.workflow.nodes.is_empty() {
        return Err("method.workflow.nodes must contain at least one node".into());
    }
    let mut node_ids = HashSet::new();
    for node in &method.workflow.nodes {
        require_nonempty("method.workflow.nodes[].id", &node.id)?;
        require_nonempty("method.workflow.nodes[].type", &node.node_type)?;
        if !node_ids.insert(node.id.as_str()) {
            return Err(format!("method.workflow node id '{}' is duplicated", node.id));
        }
    }
    for node in &method.workflow.nodes {
        for dep in &node.depends_on {
            if !node_ids.contains(dep.as_str()) {
                return Err(format!(
                    "method.workflow node '{}' depends on unknown node '{}'",
                    node.id, dep
                ));
            }
        }
    }
    detect_cycles(&method.workflow.nodes)?;
    Ok(())
}

pub(crate) fn detect_cycles(nodes: &[MethodWorkflowNode]) -> Result<(), String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Unseen,
        InProgress,
        Done,
    }

    fn visit<'a>(
        id: &'a str,
        marks: &mut HashMap<&'a str, Mark>,
        nodes_by_id: &HashMap<&'a str, &'a MethodWorkflowNode>,
    ) -> Result<(), String> {
        match marks.get(id).copied().unwrap_or(Mark::Unseen) {
            Mark::Done => return Ok(()),
            Mark::InProgress => {
                return Err(format!("method.workflow has a cycle through '{}'", id))
            }
            Mark::Unseen => {}
        }
        marks.insert(id, Mark::InProgress);
        if let Some(node) = nodes_by_id.get(id) {
            for dep in &node.depends_on {
                visit(dep, marks, nodes_by_id)?;
            }
        }
        marks.insert(id, Mark::Done);
        Ok(())
    }

    let mut marks: HashMap<&str, Mark> =
        nodes.iter().map(|n| (n.id.as_str(), Mark::Unseen)).collect();
    let nodes_by_id: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    for node in nodes {
        visit(&node.id, &mut marks, &nodes_by_id)?;
    }
    Ok(())
}
