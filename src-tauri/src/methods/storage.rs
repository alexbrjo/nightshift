use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::database::DatabaseState;

use super::model::{MethodDocument, MethodPreflightResult, MethodSummary};
use super::paths::{project_root, validate_method_source_path, validate_relative_path};
use super::preflight::preflight_method_for_root;
use super::validation::validate_method;

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub(crate) fn frozen_file_path(source_path: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let ext = Path::new(source_path).extension().and_then(|e| e.to_str()).unwrap_or("bin");
    format!("files/{}.{}", hex(&digest), ext)
}

pub(crate) fn freeze_files(
    method: &mut MethodDocument,
    project_root: &Path,
    dest: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dest.join("files"))
        .map_err(|e| format!("Failed to create method files directory: {}", e))?;
    for resource in method.workflow.nodes.iter_mut().filter(|node| node.is_resource()) {
        if !matches!(
            resource.kind.as_deref(),
            Some("prompt" | "data" | "json_schema" | "eval_script")
        ) {
            continue;
        }
        let Some(path) = resource.path.as_mut() else {
            continue;
        };
        if path.starts_with("files/") {
            continue;
        }
        validate_relative_path(path)?;
        let source = project_root.join(&path);
        let bytes = fs::read(&source)
            .map_err(|e| format!("Failed to read method file '{}': {}", path, e))?;
        let frozen_path = frozen_file_path(path, &bytes);
        let target = dest.join(&frozen_path);
        if !target.exists() {
            fs::write(&target, bytes)
                .map_err(|e| format!("Failed to freeze method file '{}': {}", path, e))?;
        }
        *path = frozen_path;
    }
    Ok(())
}

pub(crate) fn read_method_document(path: &Path) -> Result<MethodDocument, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read Method document {}: {}", path.display(), e))?;
    serde_yaml::from_str(&text)
        .map_err(|e| format!("Failed to parse Method document {}: {}", path.display(), e))
}

pub(crate) fn write_method_document(path: &Path, method: &MethodDocument) -> Result<(), String> {
    let yaml = serde_yaml::to_string(method)
        .map_err(|e| format!("Failed to serialize Method document: {}", e))?;
    fs::write(path, yaml)
        .map_err(|e| format!("Failed to write Method document {}: {}", path.display(), e))
}

fn project_relative_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_method_source_path(relative_path)?;
    Ok(root.join(relative_path))
}

fn slug_for_title(title: &str) -> String {
    let slug = title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "untitled-method".into()
    } else {
        slug
    }
}

fn method_source_summary(root: &Path, path: &Path, method: &MethodDocument) -> MethodSummary {
    let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
    MethodSummary {
        id: relative.clone(),
        title: method.title.clone(),
        content_hash: String::new(),
        folder_path: relative,
        created_at: String::new(),
    }
}

pub async fn create_method_file(
    db: State<'_, DatabaseState>,
    path: Option<String>,
    input: super::model::CreateMethodDraftInput,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled Method")
        .to_string();
    let relative_path =
        path.unwrap_or_else(|| format!("methods/{}.method.yaml", slug_for_title(&title)));
    let target = project_relative_path(&root, &relative_path)?;
    if target.exists() {
        return Err(format!("Method file already exists: {}", relative_path));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Method source directory: {}", e))?;
    }
    let method = MethodDocument {
        schema_version: 2,
        id: relative_path.trim_end_matches(".method.yaml").replace(['/', '\\'], "-"),
        title,
        objective: input.objective.unwrap_or_default().trim().to_string(),
        workflow: Default::default(),
        parameters: serde_json::Value::Object(Default::default()),
        provider: serde_json::Value::Object(Default::default()),
        outputs: Vec::new(),
        metadata: serde_json::Value::Object(Default::default()),
    };
    write_method_document(&target, &method)?;
    Ok(method)
}

pub async fn get_method_file(
    db: State<'_, DatabaseState>,
    method_path: String,
) -> Result<MethodDocument, String> {
    let root = project_root(&db)?;
    read_method_document(&project_relative_path(&root, &method_path)?)
}

pub async fn save_method_file(
    db: State<'_, DatabaseState>,
    method_path: String,
    method: MethodDocument,
) -> Result<MethodSummary, String> {
    let root = project_root(&db)?;
    let path = project_relative_path(&root, &method_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Method source directory: {}", e))?;
    }
    validate_method(&method)?;
    write_method_document(&path, &method)?;
    Ok(method_source_summary(&root, &path, &method))
}

pub async fn check_method_completeness(
    db: State<'_, DatabaseState>,
    method_path: String,
) -> Result<MethodPreflightResult, String> {
    let root = project_root(&db)?;
    let method = read_method_document(&project_relative_path(&root, &method_path)?)?;
    Ok(preflight_method_for_root(&method, &root))
}

pub async fn check_method_document_completeness(
    db: State<'_, DatabaseState>,
    method: MethodDocument,
    base_path: Option<String>,
) -> Result<MethodPreflightResult, String> {
    let root = project_root(&db)?;
    if let Some(path) = base_path {
        validate_method_source_path(&path)?;
    }
    Ok(preflight_method_for_root(&method, &root))
}
