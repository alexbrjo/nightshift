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
    validate_project_relative_path(path, false)
}

pub(crate) fn validate_app_managed_relative_path(path: &str) -> Result<(), String> {
    validate_project_relative_path(path, true)
}

pub(crate) fn validate_execution_artifact_relative_path(path: &str) -> Result<(), String> {
    validate_app_managed_relative_path(path)?;
    let mut normal_components =
        Path::new(path).components().filter_map(|component| match component {
            std::path::Component::Normal(name) => Some(name.to_string_lossy()),
            _ => None,
        });
    let is_execution_artifact_path = normal_components
        .next()
        .is_some_and(|component| component.eq_ignore_ascii_case(".nightshift"))
        && normal_components
            .next()
            .is_some_and(|component| component.eq_ignore_ascii_case("executions"));
    if !is_execution_artifact_path {
        return Err(format!(
            "Method artifact path must point inside .nightshift/executions: {}",
            path
        ));
    }
    Ok(())
}

fn validate_project_relative_path(path: &str, allow_app_managed: bool) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_absolute() {
        return Err(format!("Method file path must be project-relative: {}", path));
    }
    for component in p.components() {
        match component {
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => {
                return Err(format!("Method file path must be project-relative: {}", path));
            }
            std::path::Component::Normal(name)
                if !allow_app_managed
                    && name.to_string_lossy().eq_ignore_ascii_case(".nightshift") =>
            {
                return Err(format!(
                    "Method file path cannot point inside app-managed storage: {}",
                    path
                ));
            }
            _ => {}
        }
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
