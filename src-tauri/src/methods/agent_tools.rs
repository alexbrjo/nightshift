use std::path::Path;

use serde_json::{json, Value};

use super::draft::{
    create_draft_for_root, explain_current_draft_for_root, get_current_draft_for_root,
    replace_draft_graph_for_root, reset_draft_for_root, update_draft_metadata_for_root,
};
use super::model::{
    CreateMethodDraftInput, ReplaceMethodDraftGraphInput, UpdateMethodDraftMetadataInput,
};

const GET_CURRENT_DRAFT: &str = "get_current_method_draft";
const CREATE_DRAFT: &str = "create_method_draft";
const UPDATE_METADATA: &str = "update_method_draft_metadata";
const REPLACE_GRAPH: &str = "replace_method_draft_graph";
const EXPLAIN_DRAFT: &str = "explain_current_method_draft";
const RESET_DRAFT: &str = "reset_method_draft";

pub fn method_function_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": GET_CURRENT_DRAFT,
            "description": "Read the current durable draft Method state from Nightshift.",
            "parameters": object_schema(json!({}), vec![]),
            "strict": true
        }),
        json!({
            "type": "function",
            "name": CREATE_DRAFT,
            "description": "Create a durable draft Method with title and objective. Use this when the user describes a new benchmark or experiment concept.",
            "parameters": object_schema(json!({
                "title": { "type": "string", "description": "Concise Method title." },
                "objective": { "type": "string", "description": "The benchmark or experiment objective." }
            }), vec!["title", "objective"]),
            "strict": true
        }),
        json!({
            "type": "function",
            "name": UPDATE_METADATA,
            "description": "Update the current draft Method title and objective without changing its graph.",
            "parameters": object_schema(json!({
                "title": { "type": "string", "description": "Concise Method title." },
                "objective": { "type": "string", "description": "The benchmark or experiment objective." }
            }), vec!["title", "objective"]),
            "strict": true
        }),
        json!({
            "type": "function",
            "name": REPLACE_GRAPH,
            "description": "Replace the current draft Method graph. The graph may be incomplete, but it must be a DAG with valid edge endpoints.",
            "parameters": object_schema(json!({
                "nodes": {
                    "type": "array",
                    "items": object_schema(json!({
                        "id": { "type": "string", "description": "Stable node id, lower snake/kebab style." },
                        "label": { "type": "string", "description": "Human-readable node label." },
                        "type": { "type": "string", "enum": ["inference", "eval", "aggregate", "analysis"] },
                        "status": { "type": "string", "enum": ["draft", "ready", "blocked"] }
                    }), vec!["id", "label", "type", "status"])
                },
                "edges": {
                    "type": "array",
                    "items": object_schema(json!({
                        "from": { "type": "string" },
                        "to": { "type": "string" }
                    }), vec!["from", "to"])
                },
                "resources": {
                    "type": "array",
                    "items": object_schema(json!({
                        "id": { "type": "string" },
                        "kind": { "type": "string", "enum": ["prompt", "data", "json_schema", "eval_script", "collection", "secret_ref", "unknown"] },
                        "label": { "type": "string" },
                        "status": { "type": "string", "enum": ["missing", "named", "attached", "unknown"] },
                        "path": { "type": ["string", "null"] },
                        "consumedBy": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }), vec!["id", "kind", "label", "status", "path", "consumedBy"])
                }
            }), vec!["nodes", "edges", "resources"]),
            "strict": true
        }),
        json!({
            "type": "function",
            "name": EXPLAIN_DRAFT,
            "description": "Explain the current durable draft state, including readiness blockers and warnings.",
            "parameters": object_schema(json!({}), vec![]),
            "strict": true
        }),
        json!({
            "type": "function",
            "name": RESET_DRAFT,
            "description": "Reset the current durable draft Method state when the user explicitly asks to start over.",
            "parameters": object_schema(json!({}), vec![]),
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
        GET_CURRENT_DRAFT => Ok(json!({ "draft": get_current_draft_for_root(root)? })),
        CREATE_DRAFT => {
            let input: CreateMethodDraftInput = serde_json::from_value(arguments)
                .map_err(|e| format!("Invalid create draft arguments: {}", e))?;
            Ok(json!({ "draft": create_draft_for_root(root, input)? }))
        }
        UPDATE_METADATA => {
            let input: UpdateMethodDraftMetadataInput = serde_json::from_value(arguments)
                .map_err(|e| format!("Invalid metadata arguments: {}", e))?;
            Ok(json!({ "draft": update_draft_metadata_for_root(root, input)? }))
        }
        REPLACE_GRAPH => {
            let input: ReplaceMethodDraftGraphInput = serde_json::from_value(arguments)
                .map_err(|e| format!("Invalid graph arguments: {}", e))?;
            Ok(json!({ "draft": replace_draft_graph_for_root(root, input)? }))
        }
        EXPLAIN_DRAFT => Ok(json!({ "explanation": explain_current_draft_for_root(root)? })),
        RESET_DRAFT => Ok(json!({ "draft": reset_draft_for_root(root)? })),
        _ => Err(format!("Unknown Method tool '{}'", name)),
    }
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
                && tool.get("name").and_then(Value::as_str) == Some("create_method_draft")
                && tool.get("strict").and_then(Value::as_bool) == Some(true)
        }));
        assert!(tools.iter().any(|tool| {
            tool.get("name").and_then(Value::as_str) == Some("replace_method_draft_graph")
        }));
    }

    #[test]
    fn dispatch_create_and_replace_graph_updates_durable_draft() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-tool-dispatch-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join(".nightshift")).unwrap();

        dispatch_method_tool(
            &temp,
            "create_method_draft",
            json!({
                "title": "Rubric benchmark",
                "objective": "Compare answers against a rubric"
            }),
        )
        .unwrap();
        let result = dispatch_method_tool(
            &temp,
            "replace_method_draft_graph",
            json!({
                "nodes": [
                    { "id": "generate", "label": "Generate answers", "type": "inference", "status": "draft" },
                    { "id": "score", "label": "Score answers", "type": "eval", "status": "blocked" }
                ],
                "edges": [{ "from": "generate", "to": "score" }],
                "resources": []
            }),
        )
        .unwrap();

        assert_eq!(result["draft"]["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(get_current_draft_for_root(&temp).unwrap().unwrap().edges.len(), 1);
        fs::remove_dir_all(temp).unwrap();
    }
}
