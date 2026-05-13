use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::database::DatabaseState;

use super::config::normalized_resource_kind;
use super::model::{
    CreateMethodDraftInput, MethodDocument, MethodDraftIssue, MethodDraftReadiness,
    MethodLifecycleState, MethodSummary, MethodWorkflow, MethodWorkflowNode,
    ReplaceMethodDraftGraphInput, UpdateMethodDraftExecutionConfigInput,
    UpdateMethodDraftMetadataInput,
};
use super::paths::{project_root, require_nonempty};
use super::storage::{read_method_document, save_method_to_project, write_method_document};

const FILE_RESOURCE_KINDS: &[&str] = &["prompt", "data", "json_schema", "eval_script"];
const RESOURCE_KINDS: &[&str] =
    &["prompt", "data", "json_schema", "eval_script", "collection", "api_key"];
fn draft_path(root: &Path) -> PathBuf {
    root.join(".nightshift").join("current_method_draft.yaml")
}

fn default_title(input: Option<String>) -> String {
    input
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Untitled Method".into())
}

pub(crate) fn default_draft(input: CreateMethodDraftInput) -> MethodDocument {
    MethodDocument {
        schema_version: 2,
        id: format!("draft-{}", Uuid::new_v4()),
        title: default_title(input.title),
        objective: input.objective.unwrap_or_default().trim().to_string(),
        workflow: MethodWorkflow { nodes: Vec::new() },
        parameters: serde_json::Value::Object(Default::default()),
        provider: serde_json::Value::Object(Default::default()),
        outputs: Vec::new(),
        metadata: serde_json::Value::Object(Default::default()),
    }
}

pub(crate) fn derive_readiness(draft: &MethodDocument) -> MethodDraftReadiness {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if draft.title.trim().is_empty() || draft.title == "Untitled Method" {
        blockers.push(MethodDraftIssue {
            code: "missing_title".into(),
            message: "Add a specific Method title.".into(),
            node_id: None,
            resource_id: None,
        });
    }
    if draft.objective.trim().is_empty() {
        blockers.push(MethodDraftIssue {
            code: "missing_objective".into(),
            message: "Describe the benchmark or experiment objective.".into(),
            node_id: None,
            resource_id: None,
        });
    }
    if draft.workflow.nodes.is_empty() {
        blockers.push(MethodDraftIssue {
            code: "missing_nodes".into(),
            message: "Add at least one Method node before validation or execution.".into(),
            node_id: None,
            resource_id: None,
        });
    }
    if !draft.workflow.nodes.iter().any(|node| node.is_resource()) {
        warnings.push(MethodDraftIssue {
            code: "missing_resources".into(),
            message: "No resource nodes are attached yet.".into(),
            node_id: None,
            resource_id: None,
        });
    }
    if validate_graph(&draft.workflow.nodes).is_err() {
        blockers.push(MethodDraftIssue {
            code: "invalid_graph".into(),
            message: "The draft graph has invalid edge endpoints or cycles.".into(),
            node_id: None,
            resource_id: None,
        });
    }
    validate_resource_contracts(&draft, &mut blockers, &mut warnings);

    let next = if blockers.is_empty() {
        MethodLifecycleState::Ready
    } else {
        MethodLifecycleState::Drafting
    };
    MethodDraftReadiness { status: next, blockers, warnings }
}

pub(crate) fn refresh_readiness(draft: MethodDocument) -> MethodDocument {
    let _ = derive_readiness(&draft);
    draft
}

pub(crate) fn normalize_analysis_nodes(mut draft: MethodDocument) -> MethodDocument {
    normalize_analysis_workflow_nodes(&mut draft.workflow.nodes);
    draft
}

fn normalize_analysis_workflow_nodes(nodes: &mut [MethodWorkflowNode]) {
    for node in nodes {
        if node.node_type == "aggregate" {
            node.node_type = "analysis".into();
        }
    }
}

fn validate_resource_contracts(
    draft: &MethodDocument,
    blockers: &mut Vec<MethodDraftIssue>,
    warnings: &mut Vec<MethodDraftIssue>,
) {
    let node_by_id: HashMap<&str, &MethodWorkflowNode> =
        draft.workflow.nodes.iter().map(|node| (node.id.as_str(), node)).collect();

    for resource in draft.workflow.nodes.iter().filter(|node| node.is_resource()) {
        let kind = resource.kind.as_deref().unwrap_or_default();
        if !RESOURCE_KINDS.contains(&kind) {
            blockers.push(MethodDraftIssue {
                code: "invalid_resource_kind".into(),
                message: format!("Resource '{}' has unsupported kind '{}'.", resource.label, kind),
                node_id: None,
                resource_id: Some(resource.id.clone()),
            });
        }
        if resource_is_missing(resource) {
            blockers.push(MethodDraftIssue {
                code: "missing_resource".into(),
                message: format!(
                    "Attach {} for '{}'.",
                    resource_kind_label(kind),
                    resource.label_or_id()
                ),
                node_id: first_consumer_id(draft, &resource.id),
                resource_id: Some(resource.id.clone()),
            });
        }
        if first_consumer_id(draft, &resource.id).is_none() {
            warnings.push(MethodDraftIssue {
                code: "unused_resource".into(),
                message: format!(
                    "Resource '{}' is not depended on by any node.",
                    resource.label_or_id()
                ),
                node_id: None,
                resource_id: Some(resource.id.clone()),
            });
        }
    }

    for node in draft.workflow.nodes.iter().filter(|node| node.is_runnable()) {
        for dep in &node.depends_on {
            let Some(resource) = node_by_id.get(dep.as_str()).filter(|dep| dep.is_resource())
            else {
                continue;
            };
            let kind = resource.kind.as_deref().unwrap_or_default();
            if !resource_kind_matches_node(kind, &node.node_type) {
                blockers.push(MethodDraftIssue {
                    code: "resource_node_kind_mismatch".into(),
                    message: format!(
                        "{} cannot be provided to a {} node.",
                        resource_kind_label(kind),
                        node.node_type
                    ),
                    node_id: Some(node.id.clone()),
                    resource_id: Some(resource.id.clone()),
                });
            }
        }
    }
}

fn first_consumer_id(draft: &MethodDocument, resource_id: &str) -> Option<String> {
    draft
        .workflow
        .nodes
        .iter()
        .find(|node| node.is_runnable() && node.depends_on.iter().any(|dep| dep == resource_id))
        .map(|node| node.id.clone())
}

fn resource_is_missing(resource: &MethodWorkflowNode) -> bool {
    let kind = resource.kind.as_deref().unwrap_or_default();
    if FILE_RESOURCE_KINDS.contains(&kind) {
        return resource.path.as_deref().is_none_or(|path| path.trim().is_empty());
    }
    matches!(kind, "collection" | "api_key")
        && resource.reference.as_deref().is_none_or(|reference| reference.trim().is_empty())
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

fn resource_kind_matches_node(kind: &str, node_type: &str) -> bool {
    match normalized_resource_kind(kind) {
        "prompt" | "api_key" => node_type == "inference",
        "json_schema" => matches!(node_type, "inference" | "eval"),
        "eval_script" => matches!(node_type, "eval" | "transform"),
        "data" | "collection" => matches!(node_type, "sample" | "inference" | "eval" | "transform"),
        _ => false,
    }
}

pub(crate) fn validate_graph(nodes: &[MethodWorkflowNode]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let nodes_by_id: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    for node in nodes {
        require_nonempty("method.workflow.nodes[].id", &node.id)?;
        require_nonempty("method.workflow.nodes[].type", &node.node_type)?;
        if !ids.insert(node.id.as_str()) {
            return Err(format!("draft node id '{}' is duplicated", node.id));
        }
        if node.is_resource() {
            let kind = node.kind.as_deref().unwrap_or_default();
            require_nonempty("method.workflow.nodes[].kind", kind)?;
            if !RESOURCE_KINDS.contains(&kind) {
                return Err(format!(
                    "draft resource node '{}' has unsupported kind '{}'",
                    node.id, kind
                ));
            }
            if !node.depends_on.is_empty() {
                return Err(format!(
                    "draft resource node '{}' cannot depend on other nodes",
                    node.id
                ));
            }
        }
    }
    for node in nodes {
        for dep in &node.depends_on {
            if !ids.contains(dep.as_str()) {
                return Err(format!(
                    "method.workflow node '{}' depends on unknown node '{}'",
                    node.id, dep
                ));
            }
            if let Some(resource) = nodes_by_id.get(dep.as_str()).filter(|dep| dep.is_resource()) {
                let kind = resource.kind.as_deref().unwrap_or_default();
                if !resource_kind_matches_node(kind, &node.node_type) {
                    return Err(format!(
                        "{} cannot be provided to a {} node",
                        resource_kind_label(kind),
                        node.node_type
                    ));
                }
            }
        }
    }
    detect_graph_cycles(nodes)
}

fn detect_graph_cycles(nodes: &[MethodWorkflowNode]) -> Result<(), String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Unseen,
        InProgress,
        Done,
    }

    fn visit<'a>(
        id: &'a str,
        nodes_by_id: &HashMap<&'a str, &'a MethodWorkflowNode>,
        marks: &mut HashMap<&'a str, Mark>,
    ) -> Result<(), String> {
        match marks.get(id).copied().unwrap_or(Mark::Unseen) {
            Mark::Done => return Ok(()),
            Mark::InProgress => return Err(format!("draft graph has a cycle through '{}'", id)),
            Mark::Unseen => {}
        }
        marks.insert(id, Mark::InProgress);
        if let Some(node) = nodes_by_id.get(id) {
            for dep in &node.depends_on {
                if nodes_by_id.get(dep.as_str()).is_some_and(|dep_node| dep_node.is_resource()) {
                    continue;
                }
                visit(dep, nodes_by_id, marks)?;
            }
        }
        marks.insert(id, Mark::Done);
        Ok(())
    }

    let nodes_by_id: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut marks: HashMap<&str, Mark> =
        nodes.iter().map(|node| (node.id.as_str(), Mark::Unseen)).collect();
    for node in nodes.iter().filter(|node| node.is_runnable()) {
        visit(&node.id, &nodes_by_id, &mut marks)?;
    }
    Ok(())
}

fn read_draft_from_root(root: &Path) -> Result<Option<MethodDocument>, String> {
    let path = draft_path(root);
    if !path.exists() {
        return Ok(None);
    }
    read_method_document(&path).map(Some)
}

fn write_draft_to_root(root: &Path, draft: &MethodDocument) -> Result<(), String> {
    let path = draft_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Nightshift draft directory: {}", e))?;
    }
    write_method_document(&path, draft)
}

pub(crate) fn method_document_for_save(draft: &MethodDocument) -> Result<MethodDocument, String> {
    let readiness = derive_readiness(draft);
    if !readiness.blockers.is_empty() {
        let messages = readiness
            .blockers
            .iter()
            .map(|blocker| blocker.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("Current Method draft is not ready to save: {}", messages));
    }
    tracing::info!(
        draft_id = %draft.id,
        title = %draft.title,
        nodes = draft.workflow.nodes.len(),
        resources = draft.workflow.nodes.iter().filter(|node| node.is_resource()).count(),
        "Preparing Method document for save"
    );
    Ok(draft.clone())
}

fn read_or_default_draft(root: &Path) -> Result<MethodDocument, String> {
    Ok(read_draft_from_root(root)?
        .unwrap_or_else(|| default_draft(CreateMethodDraftInput { title: None, objective: None })))
}

fn emit_draft(
    app: &AppHandle,
    draft: Option<MethodDocument>,
) -> Result<Option<MethodDocument>, String> {
    app.emit("method-draft-updated", draft.clone())
        .map_err(|e| format!("Failed to emit Method draft update: {}", e))?;
    Ok(draft)
}

pub(crate) fn get_current_draft_for_root(root: &Path) -> Result<Option<MethodDocument>, String> {
    let Some(draft) = read_draft_from_root(root)? else {
        return Ok(None);
    };
    let normalized = normalize_analysis_nodes(draft.clone());
    if normalized != draft {
        write_draft_to_root(root, &normalized)?;
    }
    Ok(Some(normalized))
}

pub(crate) fn create_draft_for_root(
    root: &Path,
    input: CreateMethodDraftInput,
) -> Result<MethodDocument, String> {
    let draft = default_draft(input);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn update_draft_metadata_for_root(
    root: &Path,
    input: UpdateMethodDraftMetadataInput,
) -> Result<MethodDocument, String> {
    let mut draft = read_draft_from_root(root)?.unwrap_or_else(|| {
        default_draft(CreateMethodDraftInput {
            title: input.title.clone(),
            objective: input.objective.clone(),
        })
    });
    if let Some(title) = input.title {
        draft.title = title.trim().to_string();
    }
    if let Some(objective) = input.objective {
        draft.objective = objective.trim().to_string();
    }
    let draft = refresh_readiness(draft);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn update_draft_execution_config_for_root(
    root: &Path,
    input: UpdateMethodDraftExecutionConfigInput,
) -> Result<MethodDocument, String> {
    let mut draft = read_or_default_draft(root)?;
    if let Some(provider) = input.provider {
        draft.provider = provider;
    }
    if let Some(parameters) = input.parameters {
        draft.parameters = parameters;
    }
    let draft = refresh_readiness(draft);
    tracing::info!(
        project_root = %root.display(),
        draft_id = %draft.id,
        provider = ?draft.provider,
        parameters = ?draft.parameters,
        "Updated Method draft execution config"
    );
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn replace_draft_graph_for_root(
    root: &Path,
    input: ReplaceMethodDraftGraphInput,
) -> Result<MethodDocument, String> {
    validate_graph(&input.workflow.nodes)?;
    let mut draft = read_draft_from_root(root)?
        .unwrap_or_else(|| default_draft(CreateMethodDraftInput { title: None, objective: None }));
    draft.workflow = input.workflow;
    normalize_analysis_workflow_nodes(&mut draft.workflow.nodes);
    let draft = refresh_readiness(draft);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn explain_current_draft_for_root(root: &Path) -> Result<String, String> {
    let Some(draft) = read_draft_from_root(root)? else {
        return Ok("No Method draft exists yet.".into());
    };
    let readiness = derive_readiness(&draft);
    let mut lines = vec![
        format!("{} is currently {:?}.", draft.title, readiness.status),
        format!(
            "Objective: {}",
            if draft.objective.is_empty() { "not set" } else { &draft.objective }
        ),
        format!("Nodes: {}", draft.workflow.nodes.len()),
        format!(
            "Edges: {}",
            draft.workflow.nodes.iter().map(|node| node.depends_on.len()).sum::<usize>()
        ),
        format!(
            "Resources: {}",
            draft.workflow.nodes.iter().filter(|node| node.is_resource()).count()
        ),
    ];
    for blocker in &readiness.blockers {
        lines.push(format!("Blocker: {}", blocker.message));
    }
    for warning in &readiness.warnings {
        lines.push(format!("Warning: {}", warning.message));
    }
    Ok(lines.join("\n"))
}

pub(crate) fn reset_draft_for_root(root: &Path) -> Result<Option<MethodDocument>, String> {
    let path = draft_path(root);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to reset Method draft: {}", e))?;
    }
    Ok(None)
}

pub(crate) async fn save_current_draft_for_root(
    db: &DatabaseState,
    root: &Path,
) -> Result<MethodSummary, String> {
    let draft =
        read_draft_from_root(root)?.ok_or_else(|| "No Method draft exists yet.".to_string())?;
    tracing::info!(
        project_root = %root.display(),
        draft_id = %draft.id,
        title = %draft.title,
        provider = ?draft.provider,
        parameters = ?draft.parameters,
        "Saving current Method draft"
    );
    let method = method_document_for_save(&draft)?;
    let summary = save_method_to_project(db, root, method).await?;
    tracing::info!(
        method_id = %summary.id,
        folder_path = %summary.folder_path,
        content_hash = %summary.content_hash,
        "Saved current Method draft"
    );
    Ok(summary)
}

#[tauri::command]
pub async fn get_current_method_draft(
    db: State<'_, DatabaseState>,
) -> Result<Option<MethodDocument>, String> {
    let root = project_root(&db)?;
    get_current_draft_for_root(&root)
}

#[tauri::command]
pub async fn create_method_draft(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: CreateMethodDraftInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = create_draft_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn update_method_draft_metadata(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: UpdateMethodDraftMetadataInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = update_draft_metadata_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn update_method_draft_execution_config(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: UpdateMethodDraftExecutionConfigInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = update_draft_execution_config_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn replace_method_draft_graph(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: ReplaceMethodDraftGraphInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = replace_draft_graph_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn explain_current_method_draft(db: State<'_, DatabaseState>) -> Result<String, String> {
    let root = project_root(&db)?;
    explain_current_draft_for_root(&root)
}

#[tauri::command]
pub async fn reset_method_draft(
    app: AppHandle,
    db: State<'_, DatabaseState>,
) -> Result<Option<MethodDocument>, String> {
    let root = project_root(&db)?;
    let draft = reset_draft_for_root(&root)?;
    emit_draft(&app, draft)
}

#[tauri::command]
pub async fn save_current_method_draft(
    db: State<'_, DatabaseState>,
) -> Result<MethodSummary, String> {
    let root = project_root(&db)?;
    save_current_draft_for_root(&db, &root).await
}
