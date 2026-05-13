use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

use crate::database::DatabaseState;

use super::model::{MethodDocument, MethodPreflightResult, MethodSummary, SaveMethodInput};
use super::paths::{
    method_dir, methods_dir, project_root, validate_method_id, validate_relative_path,
};
use super::preflight::{format_preflight_blockers, preflight_method_for_root};
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

pub(crate) fn hash_directory(folder: &Path) -> Result<String, String> {
    let mut paths = Vec::new();
    fn collect(dir: &Path, root: &Path, paths: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in
            fs::read_dir(dir).map_err(|e| format!("Failed to read method folder: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read method folder entry: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                collect(&path, root, paths)?;
            } else {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| format!("Failed to hash method folder: {}", e))?
                    .to_path_buf();
                paths.push(rel);
            }
        }
        Ok(())
    }
    collect(folder, folder, &mut paths)?;
    paths.sort();

    let mut hasher = Sha256::new();
    for rel in paths {
        let rel_text = rel.to_string_lossy();
        hasher.update(rel_text.as_bytes());
        hasher.update([0]);
        let bytes = fs::read(folder.join(&rel))
            .map_err(|e| format!("Failed to hash method file '{}': {}", rel_text, e))?;
        hasher.update(bytes);
        hasher.update([0]);
    }
    Ok(hex(&hasher.finalize()))
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

fn method_document_for_content_hash(method: &MethodDocument) -> MethodDocument {
    let mut canonical = method.clone();
    canonical.id.clear();
    canonical
}

pub(crate) fn read_manifest(folder: &Path) -> Result<MethodDocument, String> {
    read_method_document(&folder.join("method.yaml"))
}

pub(crate) async fn upsert_method_metadata(
    db: &DatabaseState,
    method: &MethodDocument,
    content_hash: &str,
    folder_path: &Path,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO methods (id, title, content_hash, folder_path)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            content_hash = excluded.content_hash,
            folder_path = excluded.folder_path
        "#,
    )
    .bind(&method.id)
    .bind(&method.title)
    .bind(content_hash)
    .bind(folder_path.to_string_lossy().to_string())
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to store method metadata: {}", e))?;
    Ok(())
}

pub(crate) async fn save_method_to_project(
    db: &DatabaseState,
    root: &Path,
    method_input: MethodDocument,
) -> Result<MethodSummary, String> {
    validate_method(&method_input)?;
    for resource in method_input.workflow.nodes.iter().filter(|node| node.is_resource()) {
        if resource.path.as_deref().is_some_and(|path| path.starts_with("files/")) {
            return Err(format!(
                "Method resource '{}' must reference a project file before save",
                resource.id
            ));
        }
    }
    let preflight = preflight_method_for_root(&method_input, root);
    if preflight.status != "ready" {
        return Err(format!(
            "Method is not ready to save. {}",
            format_preflight_blockers(&preflight)
        ));
    }
    let final_dir = method_dir(root, &method_input.id);

    fs::create_dir_all(methods_dir(&root))
        .map_err(|e| format!("Failed to create methods directory: {}", e))?;
    let temp_dir = methods_dir(&root).join(format!(".{}.tmp", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp method: {}", e))?;

    let mut method = method_input;
    if let Err(e) = freeze_files(&mut method, &root, &temp_dir)
        .and_then(|_| write_method_document(&temp_dir.join("method.yaml"), &method))
    {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    let content_hash = match hash_directory(&temp_dir) {
        Ok(hash) => hash,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(e);
        }
    };

    let backup_dir = if final_dir.exists() {
        let backup = methods_dir(&root).join(format!(".{}.bak", Uuid::new_v4()));
        if let Err(e) = fs::rename(&final_dir, &backup) {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(format!("Failed to replace existing method folder: {}", e));
        }
        Some(backup)
    } else {
        None
    };

    if let Err(e) = fs::rename(&temp_dir, &final_dir) {
        if let Some(backup) = backup_dir.as_ref() {
            let _ = fs::rename(backup, &final_dir);
        }
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("Failed to finalize method folder: {}", e));
    }
    if let Some(backup) = backup_dir {
        let _ = fs::remove_dir_all(backup);
    }

    upsert_method_metadata(db, &method, &content_hash, &final_dir).await?;
    get_method_summary(db, &method.id).await
}

pub(crate) async fn save_method_to_project_content_addressed(
    db: &DatabaseState,
    root: &Path,
    method_input: MethodDocument,
) -> Result<MethodSummary, String> {
    validate_method(&method_input)?;
    for resource in method_input.workflow.nodes.iter().filter(|node| node.is_resource()) {
        if resource.path.as_deref().is_some_and(|path| path.starts_with("files/")) {
            return Err(format!(
                "Method resource '{}' must reference a project file before save",
                resource.id
            ));
        }
    }
    let preflight = preflight_method_for_root(&method_input, root);
    if preflight.status != "ready" {
        return Err(format!(
            "Method is not ready to execute. {}",
            format_preflight_blockers(&preflight)
        ));
    }

    fs::create_dir_all(methods_dir(&root))
        .map_err(|e| format!("Failed to create methods directory: {}", e))?;
    let temp_dir = methods_dir(&root).join(format!(".{}.tmp", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp method: {}", e))?;

    let mut frozen = method_input;
    if let Err(e) = freeze_files(&mut frozen, &root, &temp_dir).and_then(|_| {
        write_method_document(
            &temp_dir.join("method.yaml"),
            &method_document_for_content_hash(&frozen),
        )
    }) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    let content_hash = match hash_directory(&temp_dir) {
        Ok(hash) => hash,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(e);
        }
    };
    frozen.id = format!("method-{}", content_hash);
    let final_dir = method_dir(root, &frozen.id);

    if let Err(e) = write_method_document(&temp_dir.join("method.yaml"), &frozen) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    if final_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    } else if let Err(e) = fs::rename(&temp_dir, &final_dir) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("Failed to finalize method folder: {}", e));
    }

    upsert_method_metadata(db, &frozen, &content_hash, &final_dir).await?;
    get_method_summary(db, &frozen.id).await
}

pub(crate) async fn get_method_summary(
    db: &DatabaseState,
    id: &str,
) -> Result<MethodSummary, String> {
    sqlx::query_as::<_, MethodSummary>(
        r#"
        SELECT id, title, content_hash, folder_path, created_at
        FROM methods
        WHERE id = ?1
        "#,
    )
    .bind(id)
    .fetch_one(&db.pool())
    .await
    .map_err(|e| format!("Failed to read method metadata: {}", e))
}

#[tauri::command]
pub async fn save_method(
    db: State<'_, DatabaseState>,
    input: SaveMethodInput,
) -> Result<MethodSummary, String> {
    let root = project_root(&db)?;
    save_method_to_project(&db, &root, input.method).await
}

#[tauri::command]
pub async fn preflight_method(
    db: State<'_, DatabaseState>,
    input: SaveMethodInput,
) -> Result<MethodPreflightResult, String> {
    let root = project_root(&db)?;
    Ok(preflight_method_for_root(&input.method, &root))
}

#[tauri::command]
pub async fn list_methods(db: State<'_, DatabaseState>) -> Result<Vec<MethodSummary>, String> {
    let methods = sqlx::query_as::<_, MethodSummary>(
        r#"
        SELECT id, title, content_hash, folder_path, created_at
        FROM methods
        ORDER BY created_at DESC, id ASC
        "#,
    )
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list methods: {}", e))?;
    Ok(methods)
}

#[tauri::command]
pub async fn get_method(
    db: State<'_, DatabaseState>,
    id: String,
) -> Result<MethodDocument, String> {
    validate_method_id(&id)?;
    let root = project_root(&db)?;
    let manifest = read_manifest(&method_dir(&root, &id))?;
    validate_method(&manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub async fn read_method_file(
    db: State<'_, DatabaseState>,
    id: String,
    path: String,
) -> Result<String, String> {
    validate_method_id(&id)?;
    if !path.starts_with("files/") || path.contains("..") {
        return Err("path must be a frozen method file path under files/".into());
    }
    let root = project_root(&db)?;
    fs::read_to_string(method_dir(&root, &id).join(path))
        .map_err(|e| format!("Failed to read method file: {}", e))
}
