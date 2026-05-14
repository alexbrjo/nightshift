use std::path::{Path, PathBuf};

use crate::database::DatabaseState;

pub(crate) fn project_root(db: &DatabaseState) -> Result<PathBuf, String> {
    let root = db.get_project_root();
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("No project folder is open".into());
    }
    Ok(root)
}

pub(crate) fn require_nonempty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{} must not be empty", label))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_method_id(id: &str) -> Result<(), String> {
    require_nonempty("method.id", id)?;
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("method.id must not contain path separators or '..'".into());
    }
    Ok(())
}

pub(crate) fn validate_relative_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_absolute() || path.contains("..") {
        return Err(format!("Method file path must be project-relative: {}", path));
    }
    if path.starts_with(".nightshift/") {
        return Err(format!("Method file path cannot point inside app-managed storage: {}", path));
    }
    Ok(())
}

pub(crate) fn validate_method_source_path(path: &str) -> Result<(), String> {
    validate_relative_path(path)?;
    if !path.ends_with(".method.yaml") {
        return Err("Method source files must use the .method.yaml extension".into());
    }
    Ok(())
}

pub(crate) fn execution_dir(project_root: &Path, execution_id: i64) -> PathBuf {
    project_root.join(".nightshift").join("executions").join(execution_id.to_string())
}

pub(crate) fn execution_log_path(project_root: &Path, execution_id: i64) -> PathBuf {
    execution_dir(project_root, execution_id).join("log.jsonl")
}

pub(crate) fn execution_output_path(
    project_root: &Path,
    execution_id: i64,
    node_id: &str,
) -> PathBuf {
    execution_dir(project_root, execution_id).join("outputs").join(format!("{}.jsonl", node_id))
}
