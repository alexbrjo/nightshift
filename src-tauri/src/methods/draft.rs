use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::database::DatabaseState;

use super::model::{
    CreateMethodDraftInput, MethodDraft, MethodDraftEdge, MethodDraftIssue, MethodDraftNode,
    MethodDraftReadiness, MethodLifecycleState, ReplaceMethodDraftGraphInput,
    UpdateMethodDraftMetadataInput,
};
use super::paths::{project_root, require_nonempty};

fn draft_path(root: &Path) -> PathBuf {
    root.join(".nightshift").join("current_method_draft.json")
}

fn default_title(input: Option<String>) -> String {
    input
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Untitled Method".into())
}

pub(crate) fn default_draft(input: CreateMethodDraftInput) -> MethodDraft {
    refresh_readiness(MethodDraft {
        schema_version: 1,
        id: format!("draft-{}", Uuid::new_v4()),
        title: default_title(input.title),
        objective: input.objective.unwrap_or_default().trim().to_string(),
        lifecycle: MethodLifecycleState::Drafting,
        resources: Vec::new(),
        nodes: Vec::new(),
        edges: Vec::new(),
        parameters: serde_json::Value::Object(Default::default()),
        provider_config: serde_json::Value::Object(Default::default()),
        outputs: Vec::new(),
        metadata: serde_json::json!({}),
        readiness: MethodDraftReadiness {
            status: MethodLifecycleState::Drafting,
            blockers: Vec::new(),
            warnings: Vec::new(),
        },
    })
}

pub(crate) fn refresh_readiness(mut draft: MethodDraft) -> MethodDraft {
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
    if draft.nodes.is_empty() {
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
    if validate_graph(&draft.nodes, &draft.edges).is_err() {
        blockers.push(MethodDraftIssue {
            code: "invalid_graph".into(),
            message: "The draft graph has invalid edge endpoints or cycles.".into(),
            node_id: None,
            resource_id: None,
        });
    }

    let next = if blockers.is_empty() {
        MethodLifecycleState::Ready
    } else {
        MethodLifecycleState::Drafting
    };
    draft.lifecycle = next;
    draft.readiness = MethodDraftReadiness { status: next, blockers, warnings };
    draft
}

pub(crate) fn validate_graph(
    nodes: &[MethodDraftNode],
    edges: &[MethodDraftEdge],
) -> Result<(), String> {
    let mut ids = HashSet::new();
    for node in nodes {
        require_nonempty("draft.nodes[].id", &node.id)?;
        require_nonempty("draft.nodes[].type", &node.node_type)?;
        if !ids.insert(node.id.as_str()) {
            return Err(format!("draft node id '{}' is duplicated", node.id));
        }
    }
    for edge in edges {
        if !ids.contains(edge.from.as_str()) {
            return Err(format!("draft edge starts at unknown node '{}'", edge.from));
        }
        if !ids.contains(edge.to.as_str()) {
            return Err(format!("draft edge ends at unknown node '{}'", edge.to));
        }
    }
    detect_edge_cycles(nodes, edges)
}

fn detect_edge_cycles(nodes: &[MethodDraftNode], edges: &[MethodDraftEdge]) -> Result<(), String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Unseen,
        InProgress,
        Done,
    }

    fn visit<'a>(
        id: &'a str,
        outgoing: &HashMap<&'a str, Vec<&'a str>>,
        marks: &mut HashMap<&'a str, Mark>,
    ) -> Result<(), String> {
        match marks.get(id).copied().unwrap_or(Mark::Unseen) {
            Mark::Done => return Ok(()),
            Mark::InProgress => return Err(format!("draft graph has a cycle through '{}'", id)),
            Mark::Unseen => {}
        }
        marks.insert(id, Mark::InProgress);
        for next in outgoing.get(id).into_iter().flatten() {
            visit(next, outgoing, marks)?;
        }
        marks.insert(id, Mark::Done);
        Ok(())
    }

    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        outgoing.entry(edge.from.as_str()).or_default().push(edge.to.as_str());
    }
    let mut marks: HashMap<&str, Mark> =
        nodes.iter().map(|node| (node.id.as_str(), Mark::Unseen)).collect();
    for node in nodes {
        visit(&node.id, &outgoing, &mut marks)?;
    }
    Ok(())
}

fn read_draft_from_root(root: &Path) -> Result<Option<MethodDraft>, String> {
    let path = draft_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read current Method draft: {}", e))?;
    let draft: MethodDraft = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse current Method draft: {}", e))?;
    Ok(Some(refresh_readiness(draft)))
}

fn write_draft_to_root(root: &Path, draft: &MethodDraft) -> Result<(), String> {
    let path = draft_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Nightshift draft directory: {}", e))?;
    }
    let text = serde_json::to_string_pretty(draft)
        .map_err(|e| format!("Failed to serialize Method draft: {}", e))?;
    fs::write(&path, text).map_err(|e| format!("Failed to write Method draft: {}", e))
}

fn emit_draft(app: &AppHandle, draft: Option<MethodDraft>) -> Result<Option<MethodDraft>, String> {
    app.emit("method-draft-updated", draft.clone())
        .map_err(|e| format!("Failed to emit Method draft update: {}", e))?;
    Ok(draft)
}

pub(crate) fn get_current_draft_for_root(root: &Path) -> Result<Option<MethodDraft>, String> {
    read_draft_from_root(root)
}

pub(crate) fn create_draft_for_root(
    root: &Path,
    input: CreateMethodDraftInput,
) -> Result<MethodDraft, String> {
    let draft = default_draft(input);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn update_draft_metadata_for_root(
    root: &Path,
    input: UpdateMethodDraftMetadataInput,
) -> Result<MethodDraft, String> {
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

pub(crate) fn replace_draft_graph_for_root(
    root: &Path,
    input: ReplaceMethodDraftGraphInput,
) -> Result<MethodDraft, String> {
    validate_graph(&input.nodes, &input.edges)?;
    let mut draft = read_draft_from_root(root)?
        .unwrap_or_else(|| default_draft(CreateMethodDraftInput { title: None, objective: None }));
    draft.nodes = input.nodes;
    draft.edges = input.edges;
    if let Some(resources) = input.resources {
        draft.resources = resources;
    }
    let draft = refresh_readiness(draft);
    write_draft_to_root(root, &draft)?;
    Ok(draft)
}

pub(crate) fn explain_current_draft_for_root(root: &Path) -> Result<String, String> {
    let Some(draft) = read_draft_from_root(root)? else {
        return Ok("No Method draft exists yet.".into());
    };
    let mut lines = vec![
        format!("{} is currently {:?}.", draft.title, draft.lifecycle),
        format!(
            "Objective: {}",
            if draft.objective.is_empty() { "not set" } else { &draft.objective }
        ),
        format!("Nodes: {}", draft.nodes.len()),
        format!("Edges: {}", draft.edges.len()),
        format!("Resources: {}", draft.resources.len()),
    ];
    for blocker in &draft.readiness.blockers {
        lines.push(format!("Blocker: {}", blocker.message));
    }
    for warning in &draft.readiness.warnings {
        lines.push(format!("Warning: {}", warning.message));
    }
    Ok(lines.join("\n"))
}

pub(crate) fn reset_draft_for_root(root: &Path) -> Result<Option<MethodDraft>, String> {
    let path = draft_path(root);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to reset Method draft: {}", e))?;
    }
    Ok(None)
}

#[tauri::command]
pub async fn get_current_method_draft(
    db: State<'_, DatabaseState>,
) -> Result<Option<MethodDraft>, String> {
    let root = project_root(&db)?;
    get_current_draft_for_root(&root)
}

#[tauri::command]
pub async fn create_method_draft(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: CreateMethodDraftInput,
) -> Result<MethodDraft, String> {
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
) -> Result<MethodDraft, String> {
    let root = project_root(&db)?;
    let draft = update_draft_metadata_for_root(&root, input)?;
    emit_draft(&app, Some(draft.clone()))?;
    Ok(draft)
}

#[tauri::command]
pub async fn replace_method_draft_graph(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    input: ReplaceMethodDraftGraphInput,
) -> Result<MethodDraft, String> {
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
) -> Result<Option<MethodDraft>, String> {
    let root = project_root(&db)?;
    let draft = reset_draft_for_root(&root)?;
    emit_draft(&app, draft)
}
