use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::database::DatabaseState;

use super::config::{load_nightshift_config, resolve_api_key_id};
use super::model::{
    AttachMethodResourceInput, CreateMethodDraftInput, DetachMethodResourceInput, MethodDocument,
    MethodDraftIssue, MethodDraftReadiness, MethodLifecycleState, MethodResource, MethodSummary,
    MethodWorkflow, MethodWorkflowNode, ReplaceMethodDraftGraphInput, ResolveApiKeyResourceInput,
    ResolveCollectionResourceInput, UpdateMethodDraftExecutionConfigInput,
    UpdateMethodDraftMetadataInput,
};
use super::paths::{project_root, require_nonempty};
use super::storage::{read_method_document, save_method_to_project, write_method_document};

const FILE_RESOURCE_KINDS: &[&str] = &["prompt", "data", "json_schema", "eval_script"];
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
        schema_version: 1,
        id: format!("draft-{}", Uuid::new_v4()),
        title: default_title(input.title),
        objective: input.objective.unwrap_or_default().trim().to_string(),
        resources: Vec::new(),
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
    if draft.resources.is_empty() {
        warnings.push(MethodDraftIssue {
            code: "missing_resources".into(),
            message: "No resources are attached yet.".into(),
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

fn validate_resource_contracts(
    draft: &MethodDocument,
    blockers: &mut Vec<MethodDraftIssue>,
    warnings: &mut Vec<MethodDraftIssue>,
) {
    let node_ids: HashSet<&str> =
        draft.workflow.nodes.iter().map(|node| node.id.as_str()).collect();
    let node_type_by_id: HashMap<&str, &str> = draft
        .workflow
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.node_type.as_str()))
        .collect();

    for resource in &draft.resources {
        if !RESOURCE_KINDS.contains(&resource.kind.as_str()) {
            blockers.push(MethodDraftIssue {
                code: "invalid_resource_kind".into(),
                message: format!(
                    "Resource '{}' has unsupported kind '{}'.",
                    resource.label, resource.kind
                ),
                node_id: None,
                resource_id: Some(resource.id.clone()),
            });
        }
        if resource_is_missing(resource) {
            blockers.push(MethodDraftIssue {
                code: "missing_resource".into(),
                message: format!(
                    "Attach {} for '{}'.",
                    resource_kind_label(&resource.kind),
                    resource.label
                ),
                node_id: resource.consumed_by.first().cloned(),
                resource_id: Some(resource.id.clone()),
            });
        }
        if resource.consumed_by.is_empty() {
            warnings.push(MethodDraftIssue {
                code: "unused_resource".into(),
                message: format!("Resource '{}' is not consumed by any node.", resource.label),
                node_id: None,
                resource_id: Some(resource.id.clone()),
            });
        }
        for node_id in &resource.consumed_by {
            if !node_ids.contains(node_id.as_str()) {
                blockers.push(MethodDraftIssue {
                    code: "resource_unknown_node".into(),
                    message: format!(
                        "Resource '{}' is assigned to unknown node '{}'.",
                        resource.label, node_id
                    ),
                    node_id: Some(node_id.clone()),
                    resource_id: Some(resource.id.clone()),
                });
                continue;
            }
            if let Some(node_type) = node_type_by_id.get(node_id.as_str()) {
                if !resource_kind_matches_node(&resource.kind, node_type) {
                    blockers.push(MethodDraftIssue {
                        code: "resource_node_kind_mismatch".into(),
                        message: format!(
                            "{} cannot be consumed by a {} node.",
                            resource_kind_label(&resource.kind),
                            node_type
                        ),
                        node_id: Some(node_id.clone()),
                        resource_id: Some(resource.id.clone()),
                    });
                }
            }
        }
    }
}

fn resource_is_missing(resource: &MethodResource) -> bool {
    if FILE_RESOURCE_KINDS.contains(&resource.kind.as_str()) {
        return resource.path.as_deref().is_none_or(|path| path.trim().is_empty());
    }
    matches!(resource.kind.as_str(), "collection" | "api_key")
        && resource.reference.as_deref().is_none_or(|reference| reference.trim().is_empty())
}

fn resource_kind_label(kind: &str) -> &'static str {
    match kind {
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
    match kind {
        "prompt" | "api_key" => node_type == "inference",
        "json_schema" => matches!(node_type, "inference" | "eval"),
        "eval_script" => node_type == "eval",
        "data" | "collection" => matches!(node_type, "inference" | "eval"),
        _ => false,
    }
}

pub(crate) fn validate_graph(nodes: &[MethodWorkflowNode]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for node in nodes {
        require_nonempty("method.workflow.nodes[].id", &node.id)?;
        require_nonempty("method.workflow.nodes[].type", &node.node_type)?;
        if !ids.insert(node.id.as_str()) {
            return Err(format!("draft node id '{}' is duplicated", node.id));
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
    for node in nodes {
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
        resources = draft.resources.len(),
        "Preparing Method document for save"
    );
    Ok(draft.clone())
}

fn read_or_default_draft(root: &Path) -> Result<MethodDocument, String> {
    Ok(read_draft_from_root(root)?
        .unwrap_or_else(|| default_draft(CreateMethodDraftInput { title: None, objective: None })))
}

fn normalize_resource_kind(kind: &str) -> Result<String, String> {
    let normalized = match kind.trim() {
        "prompt_file" => "prompt",
        "data_file" => "data",
        "json_schema_file" => "json_schema",
        "secret_ref" => "api_key",
        other => other,
    };
    if RESOURCE_KINDS.contains(&normalized) {
        Ok(normalized.to_string())
    } else {
        Err(format!("Unsupported Method resource kind '{}'", kind))
    }
}

fn validate_consumed_by(
    nodes: &[MethodWorkflowNode],
    consumed_by: &[String],
) -> Result<(), String> {
    let node_ids: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
    for node_id in consumed_by {
        if !node_ids.contains(node_id.as_str()) {
            return Err(format!("resource is assigned to unknown node '{}'", node_id));
        }
    }
    Ok(())
}

fn validate_generated_or_dependency_path(path: &Path) -> Result<(), String> {
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        if GENERATED_OR_DEPENDENCY_DIRS.contains(&name.as_ref()) {
            return Err(format!(
                "Method resources cannot be attached from generated, dependency, or app-managed folder '{}'",
                name
            ));
        }
    }
    Ok(())
}

fn project_relative_resource_path(root: &Path, raw_path: &str) -> Result<(String, bool), String> {
    require_nonempty("resource.path", raw_path)?;
    let raw = Path::new(raw_path);
    let root_canonical =
        root.canonicalize().map_err(|e| format!("Failed to resolve project root: {}", e))?;
    let absolute = if raw.is_absolute() { raw.to_path_buf() } else { root.join(raw) };
    let exists = absolute.is_file();
    let relative = if exists {
        let canonical = absolute
            .canonicalize()
            .map_err(|e| format!("Failed to resolve resource path '{}': {}", raw_path, e))?;
        canonical
            .strip_prefix(&root_canonical)
            .map_err(|_| {
                "Method file resources must be inside the opened project root".to_string()
            })?
            .to_path_buf()
    } else if raw.is_absolute() {
        absolute
            .strip_prefix(&root_canonical)
            .map_err(|_| {
                "Method file resources must be inside the opened project root".to_string()
            })?
            .to_path_buf()
    } else {
        raw.to_path_buf()
    };
    validate_generated_or_dependency_path(&relative)?;
    let text = relative
        .to_str()
        .ok_or_else(|| "Method resource paths must be valid UTF-8".to_string())?
        .replace('\\', "/");
    if text.contains("..") {
        return Err(format!("Method resource path must stay inside the project: {}", raw_path));
    }
    Ok((text, exists))
}

fn upsert_resource(draft: &mut MethodDocument, resource: MethodResource) {
    if let Some(existing) = draft.resources.iter_mut().find(|current| current.id == resource.id) {
        *existing = resource;
    } else {
        draft.resources.push(resource);
    }
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
    read_draft_from_root(root)
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
    if let Some(resources) = input.resources {
        draft.resources = resources;
    }
    let draft = refresh_readiness(draft);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn attach_resource_for_root(
    root: &Path,
    input: AttachMethodResourceInput,
) -> Result<MethodDocument, String> {
    let mut draft = read_or_default_draft(root)?;
    let kind = normalize_resource_kind(&input.kind)?;
    validate_consumed_by(&draft.workflow.nodes, &input.consumed_by)?;

    let path = if FILE_RESOURCE_KINDS.contains(&kind.as_str()) {
        let Some(raw_path) = input.path.as_deref() else {
            return Err(format!("{} resources require a project file path", kind));
        };
        Some(project_relative_resource_path(root, raw_path)?.0)
    } else {
        None
    };
    if !FILE_RESOURCE_KINDS.contains(&kind.as_str())
        && input.reference.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err(format!("{} resources require a reference id", kind));
    }

    let label =
        input.label.filter(|label| !label.trim().is_empty()).unwrap_or_else(|| input.id.clone());
    let resource = MethodResource {
        id: input.id,
        kind,
        label: label.trim().to_string(),
        path,
        reference: input.reference.map(|reference| reference.trim().to_string()),
        consumed_by: input.consumed_by,
    };
    upsert_resource(&mut draft, resource);
    let draft = refresh_readiness(draft);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn detach_resource_for_root(
    root: &Path,
    input: DetachMethodResourceInput,
) -> Result<MethodDocument, String> {
    let mut draft = read_or_default_draft(root)?;
    let before = draft.resources.len();
    draft.resources.retain(|resource| resource.id != input.id);
    if before == draft.resources.len() {
        return Err(format!("Method resource '{}' is not attached", input.id));
    }
    let draft = refresh_readiness(draft);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn resolve_collection_resource_for_root(
    root: &Path,
    input: ResolveCollectionResourceInput,
) -> Result<MethodDocument, String> {
    attach_resource_for_root(
        root,
        AttachMethodResourceInput {
            id: input.id,
            kind: "collection".into(),
            label: input.label,
            path: None,
            reference: Some(input.collection_id),
            consumed_by: input.consumed_by,
        },
    )
}

pub(crate) fn resolve_api_key_resource_for_root(
    root: &Path,
    input: ResolveApiKeyResourceInput,
) -> Result<MethodDocument, String> {
    let config = load_nightshift_config(root)?;
    resolve_api_key_id(&config, &input.api_key_id)?;
    attach_resource_for_root(
        root,
        AttachMethodResourceInput {
            id: input.id,
            kind: "api_key".into(),
            label: input.label,
            path: None,
            reference: Some(input.api_key_id),
            consumed_by: input.consumed_by,
        },
    )
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
        format!("Resources: {}", draft.resources.len()),
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
pub async fn attach_method_resource(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: AttachMethodResourceInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = attach_resource_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn detach_method_resource(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: DetachMethodResourceInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = detach_resource_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn resolve_method_collection_resource(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: ResolveCollectionResourceInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = resolve_collection_resource_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn resolve_method_api_key_resource(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: ResolveApiKeyResourceInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let draft = resolve_api_key_resource_for_root(&root, input)?;
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
