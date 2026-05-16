use std::path::Path;

use serde_json::{json, Value};

use super::draft::{create_draft_for_root, explain_current_draft_for_root};
use super::model::CreateMethodDraftInput;
use super::paths::validate_method_source_path;
use super::preflight::preflight_method_for_root;
use super::storage::read_method_document;

const CREATE_NEW_METHOD: &str = "create_new_method";
const EXPLAIN_METHOD: &str = "explain_method";

pub fn method_function_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": CREATE_NEW_METHOD,
            "description": "Create a new durable Method YAML skeleton with title, objective, and an empty workflow graph. Use this once at the start of a new benchmark or experiment.",
            "parameters": object_schema(json!({
                "title": { "type": "string", "description": "Concise Method title." },
                "objective": { "type": "string", "description": "The benchmark or experiment objective." }
            }), vec!["title", "objective"]),
            "strict": true
        }),
        json!({
            "type": "function",
            "name": EXPLAIN_METHOD,
            "description": "Explain and validate a Method YAML file. Use this after editing the Method file to identify readiness blockers, warnings, and execution-preflight issues.",
            "parameters": object_schema(json!({
                "path": {
                    "type": ["string", "null"],
                    "description": "Project-relative .method.yaml path to explain. Use null for the current draft at methods/current.method.yaml."
                }
            }), vec!["path"]),
            "strict": true
        }),
    ]
}

fn object_schema(properties: Value, required: Vec<&str>) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

pub fn dispatch_method_tool(root: &Path, name: &str, arguments: Value) -> Result<Value, String> {
    match name {
        CREATE_NEW_METHOD => {
            let input: CreateMethodDraftInput = serde_json::from_value(arguments)
                .map_err(|e| format!("Invalid create_new_method arguments: {}", e))?;
            Ok(json!({ "draft": create_draft_for_root(root, input)? }))
        }
        EXPLAIN_METHOD => Ok(json!({ "explanation": explain_method(root, arguments)? })),
        _ => Err(format!("Unknown Method tool '{}'", name)),
    }
}

fn explain_method(root: &Path, arguments: Value) -> Result<String, String> {
    let path = arguments.get("path").and_then(Value::as_str).filter(|path| !path.trim().is_empty());
    let Some(path) = path else {
        return explain_current_draft_for_root(root);
    };
    validate_method_source_path(path)?;
    let method = read_method_document(&root.join(path))?;
    let preflight = preflight_method_for_root(&method, root);
    let mut lines = vec![
        format!("{} preflight status: {}.", method.title, preflight.status),
        format!(
            "Objective: {}",
            if method.objective.is_empty() { "not set" } else { &method.objective }
        ),
        format!("Nodes: {}", method.workflow.nodes.len()),
        format!(
            "Edges: {}",
            method.workflow.nodes.iter().map(|node| node.depends_on.len()).sum::<usize>()
        ),
        format!(
            "Resources: {}",
            method.workflow.nodes.iter().filter(|node| node.is_resource()).count()
        ),
    ];
    for blocker in &preflight.blockers {
        lines.push(format!("Blocker: {}", blocker.message));
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::*;

    #[test]
    fn method_tools_are_exposed_as_openai_function_tools() {
        let tools = method_function_tools();

        assert!(tools.iter().any(|tool| {
            tool.get("type").and_then(Value::as_str) == Some("function")
                && tool.get("name").and_then(Value::as_str) == Some("create_new_method")
                && tool.get("strict").and_then(Value::as_bool) == Some(true)
        }));
        assert!(tools
            .iter()
            .any(|tool| { tool.get("name").and_then(Value::as_str) == Some("explain_method") }));
        assert_eq!(tools.len(), 2);
    }

    #[test]
    fn dispatch_create_and_explain_method_updates_durable_draft() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-tool-dispatch-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join(".nightshift")).unwrap();

        dispatch_method_tool(
            &temp,
            "create_new_method",
            json!({
                "title": "Rubric benchmark",
                "objective": "Compare answers against a rubric"
            }),
        )
        .unwrap();
        let result =
            dispatch_method_tool(&temp, "explain_method", json!({ "path": null })).unwrap();

        assert!(result["explanation"].as_str().unwrap().contains("Rubric benchmark"));
        fs::remove_dir_all(temp).unwrap();
    }
}
