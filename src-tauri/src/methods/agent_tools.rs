use std::path::Path;

use serde_json::{json, Value};

use super::draft::{create_draft_for_root, derive_readiness, explain_current_draft_for_root};
use super::model::CreateMethodDraftInput;
use super::paths::validate_method_source_path;
use super::preflight::preflight_method_for_root;
use super::storage::read_method_document;
use super::validation::validate_method;

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
            "description": "Explain and validate a Method YAML file. Use this after editing the Method file to identify readiness blockers, warnings, and execution-preflight issues. Set schema=true to return the canonical Method YAML schema and validation rules; this is equivalent to calling explain_method --schema.",
            "parameters": object_schema(json!({
                "path": {
                    "type": ["string", "null"],
                    "description": "Project-relative .method.yaml path to explain. Use null for the current draft at methods/current.method.yaml."
                },
                "schema": {
                    "type": "boolean",
                    "description": "Return the Method YAML schema and validation rules instead of validating a file."
                }
            }), vec!["path", "schema"]),
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
    if arguments.get("schema").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(method_schema_explanation());
    }
    let path = arguments.get("path").and_then(Value::as_str).filter(|path| !path.trim().is_empty());
    let Some(path) = path else {
        return explain_current_draft_for_root(root);
    };
    validate_method_source_path(path)?;
    let method = read_method_document(&root.join(path))?;
    let readiness = derive_readiness(&method);
    let preflight = preflight_method_for_root(&method, root);
    let mut lines = vec![
        format!("Canonical Method file: {}", path),
        "Canonical wiring: resource nodes use type=resource with kind and path/reference; runnable nodes consume them by listing resource ids in depends_on.".into(),
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
    match validate_method(&method) {
        Ok(()) => lines.push("Schema validation: passed.".into()),
        Err(error) => lines.push(format!("Schema validation error: {}", error)),
    }
    lines.push(format!("Readiness: {:?}.", readiness.status));
    for blocker in &readiness.blockers {
        lines.push(format!("Readiness blocker: {}", blocker.message));
    }
    for warning in &readiness.warnings {
        lines.push(format!("Readiness warning: {}", warning.message));
    }
    for resource in method.workflow.nodes.iter().filter(|node| node.is_resource()) {
        lines.push(format!(
            "Resource {} kind={} path={} reference={}",
            resource.id,
            resource.kind.as_deref().unwrap_or(""),
            resource.path.as_deref().unwrap_or(""),
            resource.reference.as_deref().unwrap_or("")
        ));
    }
    for blocker in &preflight.blockers {
        lines.push(format!("Preflight blocker: {}", blocker.message));
    }
    Ok(lines.join("\n"))
}

fn method_schema_explanation() -> String {
    [
        "Canonical Method YAML schema:",
        "schema_version: 2",
        "id: kebab-case method id",
        "title: Human-readable title",
        "objective: Benchmark or experiment objective",
        "provider:",
        "  provider: Provider name, for example OpenAI or local",
        "  server_url: OpenAI-compatible server URL; use provider.server_url, not base_url",
        "  model: Shared model name or list of model names for sweeps",
        "  api_key_ref: Configured API key reference id, never a raw secret",
        "parameters:",
        "  samples: Shared sample count",
        "  temperature: Shared sampling temperature",
        "  top_p: Shared nucleus sampling value",
        "workflow:",
        "  nodes:",
        "    - id: prompt",
        "      label: Prompt",
        "      type: resource",
        "      kind: prompt",
        "      path: prompts/main.jinja2",
        "    - id: generate",
        "      label: Generate",
        "      type: inference",
        "      depends_on: [prompt]",
        "      config: {}",
        "outputs: []",
        "metadata: {}",
        "",
        "Workflow node fields:",
        "- Required: id, type.",
        "- Optional: label, kind, path, reference, depends_on, config.",
        "- Supported node types: resource, sample, inference, transform, analysis.",
        "- Supported resource kinds: prompt, data, json_schema, script, api_key.",
        "- File resources use path. api_key resources use reference.",
        "- Resource nodes cannot depend on other nodes.",
        "- Runnable nodes consume resources and upstream runnable outputs by listing node ids in depends_on.",
        "",
        "Resource compatibility:",
        "- prompt, json_schema, and api_key resources can feed inference nodes.",
        "- script resources can feed transform nodes.",
        "- data resources can feed sample, inference, and transform nodes.",
        "- Analysis nodes depend on runnable outputs and may set path for the report/output file.",
        "",
        "Configuration rules:",
        "- Put shared provider/model/sampling settings in provider or parameters.",
        "- Use node config only for node-specific overrides.",
        "- Use config.prompt_file, config.data_source, config.json_schema_file, or config.script_file only to disambiguate among multiple resources of the same kind.",
        "- Those config values should be a resource id or path, not a new node.",
        "- If config.json_schema_file is set on an inference node, config.output_mode must be JSON Schema.",
        "- Do not use Input nodes, output_file nodes, or a top-level/node resources field.",
        "- Do not store raw API keys, passwords, tokens, or other secrets in Method YAML.",
        "- Resource paths must be project-relative and must not point inside generated, dependency, or app-managed folders.",
    ]
    .join("\n")
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
        let explain = tools
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("explain_method"))
            .unwrap();
        assert!(explain["description"].as_str().unwrap().contains("--schema"));
        assert_eq!(explain["parameters"]["properties"]["schema"]["type"].as_str(), Some("boolean"));
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

    #[test]
    fn explain_method_schema_returns_method_contract_without_a_file() {
        let result = dispatch_method_tool(
            Path::new("/tmp/nightshift-no-method-required"),
            "explain_method",
            json!({ "path": null, "schema": true }),
        )
        .unwrap();

        let explanation = result["explanation"].as_str().unwrap();
        assert!(explanation.contains("Canonical Method YAML schema"));
        assert!(explanation
            .contains("Supported node types: resource, sample, inference, transform, analysis"));
        assert!(explanation.contains("provider.server_url"));
        assert!(explanation.contains("Do not use Input nodes"));
    }
}
