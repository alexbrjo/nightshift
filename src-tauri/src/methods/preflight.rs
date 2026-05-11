use std::collections::HashSet;
use std::path::Path;

use super::config::{config_string, method_file_by_kind, model_values, yaml_lookup, yaml_string};
use super::model::{
    MethodDocument, MethodPreflightBlocker, MethodPreflightResult, MethodWorkflowNode,
};
use super::paths::validate_relative_path;
use super::validation::validate_method;

pub(crate) fn required_file_kind_for_node(
    method: &MethodDocument,
    node: &MethodWorkflowNode,
) -> Vec<(&'static str, String)> {
    match node.node_type.as_str() {
        "inference" => {
            let mut kinds = vec![
                ("prompt", "Inference needs a prompt template".to_string()),
                ("data", "Inference needs a data source".to_string()),
            ];
            if config_string(node, method, "output_mode", Some("Unstructured")).as_deref()
                == Some("JSON Schema")
            {
                kinds.push(("schema", "Structured inference needs a JSON schema".to_string()));
            }
            kinds
        }
        "transform" | "eval" => {
            let mut kinds = vec![("script", "Transform/eval needs a script file".to_string())];
            if node.depends_on.is_empty() {
                kinds.push(("data", "Standalone transform needs a data source".to_string()));
            }
            kinds
        }
        _ => vec![],
    }
}

pub(crate) fn preflight_method_for_root(
    method: &MethodDocument,
    project_root: &Path,
) -> MethodPreflightResult {
    let mut blockers = Vec::new();
    if let Err(error) = validate_method(method) {
        blockers.push(MethodPreflightBlocker {
            code: "invalid_method".into(),
            message: error,
            file_id: None,
            file_kind: None,
            path: None,
        });
    }

    let mut seen_required = HashSet::new();
    for node in &method.workflow.nodes {
        for (kind, message) in required_file_kind_for_node(method, node) {
            if !seen_required.insert(kind) {
                continue;
            }
            if method_file_by_kind(method, kind).is_none() {
                blockers.push(MethodPreflightBlocker {
                    code: "missing_file".into(),
                    message,
                    file_id: None,
                    file_kind: Some(kind.into()),
                    path: None,
                });
            }
        }
    }

    for file in method.resources.iter().filter(|resource| resource.path.is_some()) {
        let path = file.path.as_deref().unwrap_or_default();
        if path.starts_with("files/") {
            continue;
        }
        if let Err(error) = validate_relative_path(path) {
            blockers.push(MethodPreflightBlocker {
                code: "invalid_file_path".into(),
                message: error,
                file_id: Some(file.id.clone()),
                file_kind: Some(file.kind.clone()),
                path: Some(path.to_string()),
            });
            continue;
        }
        if !project_root.join(path).is_file() {
            blockers.push(MethodPreflightBlocker {
                code: "missing_file".into(),
                message: format!("I couldn't find {} file '{}'.", file.kind, path),
                file_id: Some(file.id.clone()),
                file_kind: Some(file.kind.clone()),
                path: Some(path.to_string()),
            });
        }
    }

    let has_inference = method.workflow.nodes.iter().any(|node| node.node_type == "inference");
    if has_inference {
        let model = yaml_string(yaml_lookup(&method.provider, "model"))
            .or_else(|| yaml_string(yaml_lookup(&method.parameters, "model")));
        if model.as_deref().unwrap_or("").trim().is_empty() && model_values(method).is_empty() {
            blockers.push(MethodPreflightBlocker {
                code: "missing_model".into(),
                message: "Inference needs a model name.".into(),
                file_id: None,
                file_kind: None,
                path: None,
            });
        }
    }

    MethodPreflightResult {
        status: if blockers.is_empty() { "ready" } else { "drafting" }.into(),
        blockers,
    }
}

pub(crate) fn format_preflight_blockers(result: &MethodPreflightResult) -> String {
    result.blockers.iter().map(|blocker| blocker.message.as_str()).collect::<Vec<_>>().join(" ")
}
