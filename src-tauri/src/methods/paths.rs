use std::path::{Path, PathBuf};

use crate::database::DatabaseState;

pub(crate) fn project_root(db: &DatabaseState) -> Result<PathBuf, String> {
    let root = db.get_project_root();
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("No project folder is open".into());
    }
    Ok(root)
}

pub(crate) fn methods_dir(project_root: &Path) -> PathBuf {
    project_root.join("methods")
}

pub(crate) fn method_dir(project_root: &Path, id: &str) -> PathBuf {
    methods_dir(project_root).join(id)
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
    if path.starts_with(".nightshift/") || path.starts_with("methods/") {
        return Err(format!("Method file path cannot point inside app-managed storage: {}", path));
    }
    Ok(())
}
