use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use uuid::Uuid;

use crate::database::DatabaseState;

use super::config::{
    load_nightshift_config, model_values, resolve_api_key_id, resolve_default_provider_profile,
    resolve_provider_profile,
};
use super::draft::{
    create_draft_for_root, default_draft, get_current_draft_for_root, method_document_for_save,
    update_draft_execution_config_for_root, validate_graph,
};
use super::execution::{
    analysis_report_relative_path, analysis_report_repair_prompt, append_jsonl,
    create_inference_job_for_node, create_sample_job_for_node, create_transform_job_for_node,
    insert_analysis_report_artifact, insert_artifact, insert_execution,
    read_method_artifact_from_db, run_analysis_sql_query, topological_nodes,
    update_execution_status, upstream_job_sources, validate_analysis_sql,
};
use super::model::*;
use super::preflight::preflight_method_for_root;
use super::storage::{freeze_files, read_method_document, write_method_document};
use super::validation::validate_method;

fn sample_method() -> MethodDocument {
    MethodDocument {
        schema_version: 2,
        id: "edge-method".into(),
        title: "Edge method".into(),
        objective: "Compare local models".into(),
        workflow: MethodWorkflow {
            nodes: vec![
                method_resource("prompt", "prompt", "prompts/main.jinja2"),
                MethodWorkflowNode {
                    id: "generate".into(),
                    label: "Generate".into(),
                    node_type: "inference".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["prompt".into()],
                    config: serde_json::Value::Null,
                },
                MethodWorkflowNode {
                    id: "analysis".into(),
                    label: "Analyze".into(),
                    node_type: "analysis".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec!["generate".into()],
                    config: serde_json::Value::Null,
                },
            ],
        },
        parameters: serde_json::Value::Null,
        provider: serde_json::Value::Null,
        outputs: vec![],
        metadata: serde_json::Value::Null,
    }
}

async fn prepare_frozen_execution(
    db: &DatabaseState,
    root: &PathBuf,
    method: MethodDocument,
) -> (MethodDocument, i64) {
    let execution_id = insert_execution(db, &method, "test-hash").await.unwrap();
    let snapshot_dir =
        root.join(".nightshift").join("executions").join(execution_id.to_string()).join("snapshot");
    let mut frozen = method;
    freeze_files(&mut frozen, root, &snapshot_dir).unwrap();
    write_method_document(&snapshot_dir.join("method.yaml"), &frozen).unwrap();
    (frozen, execution_id)
}

fn method_resource(id: &str, kind: &str, path: &str) -> MethodWorkflowNode {
    MethodWorkflowNode {
        id: id.into(),
        node_type: "resource".into(),
        kind: Some(kind.into()),
        label: id.into(),
        path: Some(path.into()),
        reference: None,
        depends_on: vec![],
        config: serde_json::Value::Null,
    }
}

fn add_resource_dependency(
    method: &mut MethodDocument,
    resource: MethodWorkflowNode,
    consumer_id: &str,
) {
    let resource_id = resource.id.clone();
    method.workflow.nodes.insert(1, resource);
    if let Some(consumer) = method.workflow.nodes.iter_mut().find(|node| node.id == consumer_id) {
        if !consumer.depends_on.contains(&resource_id) {
            consumer.depends_on.push(resource_id);
        }
    }
}

fn yaml_top_level_keys(path: &PathBuf) -> HashSet<String> {
    let yaml = fs::read_to_string(path).unwrap();
    let value: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
    value.as_mapping().unwrap().keys().map(|key| key.as_str().unwrap().to_string()).collect()
}

mod analysis;
mod artifacts;
mod draft;
mod execution_jobs;
mod preflight;
mod storage;
mod validation;
