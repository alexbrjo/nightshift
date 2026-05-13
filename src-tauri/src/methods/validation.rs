use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::config::normalized_resource_kind;
use super::model::{MethodDocument, MethodWorkflowNode};
use super::paths::{require_nonempty, validate_method_id, validate_relative_path};

const RESOURCE_KINDS: &[&str] =
    &["prompt", "data", "json_schema", "eval_script", "collection", "api_key"];
const GENERATED_OR_DEPENDENCY_DIRS: &[&str] = &[
    ".git",
    ".nightshift",
    "methods",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
];

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
    if method.schema_version != 2 {
        return Err("method.schema_version must be 2".into());
    }
    validate_method_id(&method.id)?;
    require_nonempty("method.title", &method.title)?;

    let manifest_value =
        serde_yaml::to_value(method).map_err(|e| format!("Failed to inspect method: {}", e))?;
    reject_secret_values(&manifest_value, "")?;

    if method.workflow.nodes.is_empty() {
        return Err("method.workflow.nodes must contain at least one node".into());
    }
    let mut node_ids = HashSet::new();
    let nodes_by_id: HashMap<&str, &MethodWorkflowNode> =
        method.workflow.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    for node in &method.workflow.nodes {
        require_nonempty("method.workflow.nodes[].id", &node.id)?;
        require_nonempty("method.workflow.nodes[].type", &node.node_type)?;
        if !node_ids.insert(node.id.as_str()) {
            return Err(format!("method.workflow node id '{}' is duplicated", node.id));
        }
        if node.node_type == "output_file" {
            require_nonempty(
                "method.workflow.nodes[].path",
                node.path.as_deref().unwrap_or_default(),
            )?;
            if node.path.as_deref().is_some_and(|path| {
                Path::new(path).is_absolute() || path.contains("..") || path.trim().is_empty()
            }) {
                return Err(format!(
                    "method.workflow output_file node '{}' path must stay inside the execution folder",
                    node.id
                ));
            }
        }
        if node.is_resource() {
            let kind = node.kind.as_deref().unwrap_or_default();
            require_nonempty("method.workflow.nodes[].kind", kind)?;
            if !RESOURCE_KINDS.contains(&kind) {
                return Err(format!(
                    "method.workflow resource node '{}' has unsupported kind '{}'",
                    node.id, kind
                ));
            }
            if !node.depends_on.is_empty() {
                return Err(format!(
                    "method.workflow resource node '{}' cannot depend on other nodes",
                    node.id
                ));
            }
            if let Some(path) = node.path.as_deref() {
                if !path.starts_with("files/") {
                    validate_relative_path(path)?;
                    validate_generated_or_dependency_path(path)?;
                }
            }
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
            if let Some(dep_node) = nodes_by_id.get(dep.as_str()) {
                if dep_node.is_resource() && !resource_kind_matches_node(dep_node, node) {
                    return Err(format!(
                        "{} cannot be provided to a {} node",
                        resource_kind_label(dep_node.kind.as_deref().unwrap_or_default()),
                        node.node_type
                    ));
                }
            }
        }
    }
    detect_cycles(&method.workflow.nodes)?;
    Ok(())
}

fn resource_kind_matches_node(resource: &MethodWorkflowNode, node: &MethodWorkflowNode) -> bool {
    let kind = normalized_resource_kind(resource.kind.as_deref().unwrap_or_default());
    match kind {
        "prompt" | "api_key" => node.node_type == "inference",
        "json_schema" => matches!(node.node_type.as_str(), "inference" | "eval"),
        "eval_script" => node.node_type == "eval" || node.node_type == "transform",
        "data" | "collection" => {
            matches!(node.node_type.as_str(), "sample" | "inference" | "eval" | "transform")
        }
        _ => false,
    }
}

fn resource_kind_label(kind: &str) -> &'static str {
    match normalized_resource_kind(kind) {
        "prompt" => "a prompt file",
        "data" => "a data file",
        "json_schema" => "a JSON schema file",
        "eval_script" => "an eval script",
        "collection" => "a collection",
        "api_key" => "an API key",
        _ => "a supported resource",
    }
}

fn validate_generated_or_dependency_path(path: &str) -> Result<(), String> {
    for component in Path::new(path).components() {
        let name = component.as_os_str().to_string_lossy();
        if GENERATED_OR_DEPENDENCY_DIRS.contains(&name.as_ref()) {
            return Err(format!(
                "Method resource nodes cannot point inside generated, dependency, or app-managed folder '{}'",
                name
            ));
        }
    }
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
                if nodes_by_id.get(dep.as_str()).is_some_and(|dep_node| dep_node.is_resource()) {
                    continue;
                }
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
    for node in nodes.iter().filter(|node| node.is_runnable()) {
        visit(&node.id, &mut marks, &nodes_by_id)?;
    }
    Ok(())
}
