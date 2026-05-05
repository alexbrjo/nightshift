//! File-listing helpers used by the experiment designer to populate prompt /
//! data / schema dropdowns. These are the only commands left from the legacy
//! `commands/inference.rs` after the cutover; the legacy job execution and
//! transform commands are gone.

use std::path::Path;

use tauri::State;

use crate::database::DatabaseState;

fn project_root_for_listing(db: &DatabaseState) -> Result<std::path::PathBuf, String> {
    let root = db.get_project_root();
    if root.as_os_str().is_empty() {
        return Err("No folder opened".to_string());
    }
    if !root.is_dir() {
        return Err("Project root is not a directory".to_string());
    }
    Ok(root)
}

/// Walk `base` recursively, returning project-relative paths to every file
/// whose extension matches one of `extensions` (lowercased, no dot). Skips
/// hidden directories and the usual build / dependency directories.
fn list_files_with_extensions(
    base: &Path,
    extensions: &[&str],
) -> Result<Vec<String>, String> {
    let base = std::fs::canonicalize(base)
        .map_err(|e| format!("Failed to resolve project root: {}", e))?;
    let mut files = Vec::new();

    fn walk(
        dir: &Path,
        files: &mut Vec<String>,
        base: &Path,
        extensions: &[&str],
    ) -> Result<(), String> {
        if !dir.is_dir() {
            return Ok(());
        }
        let entries =
            std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.')
                        || name == "node_modules"
                        || name == ".git"
                        || name == "target"
                        || name == "dist"
                    {
                        continue;
                    }
                }
                walk(&path, files, base, extensions)?;
            } else if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                        if let Ok(relative) = path.strip_prefix(base) {
                            if let Some(s) = relative.to_str() {
                                files.push(s.to_string());
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    walk(&base, &mut files, &base, extensions)?;
    files.sort();
    Ok(files)
}

#[tauri::command]
pub async fn list_prompt_files(db: State<'_, DatabaseState>) -> Result<Vec<String>, String> {
    let root = project_root_for_listing(&db)?;
    list_files_with_extensions(&root, &["jinja2", "prompt", "j2"])
}

#[tauri::command]
pub async fn list_data_files(db: State<'_, DatabaseState>) -> Result<Vec<String>, String> {
    let root = project_root_for_listing(&db)?;
    list_files_with_extensions(&root, &["jsonl", "ndjson", "json", "csv", "tsv"])
}

#[tauri::command]
pub async fn list_schema_files(db: State<'_, DatabaseState>) -> Result<Vec<String>, String> {
    let root = project_root_for_listing(&db)?;
    list_files_with_extensions(&root, &["json"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use uuid::Uuid;

    #[tokio::test]
    async fn list_prompt_files_finds_correct_files() {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_project_dir = temp_dir.join(format!("nightshift_prompts_test_{}", unique_id));

        fs::create_dir_all(test_project_dir.join("prompts")).unwrap();
        fs::create_dir_all(test_project_dir.join("templates")).unwrap();

        fs::write(test_project_dir.join("prompts").join("test.jinja2"), "test").unwrap();
        fs::write(test_project_dir.join("prompts").join("another.prompt"), "test").unwrap();
        fs::write(test_project_dir.join("templates").join("old.j2"), "test").unwrap();

        fs::write(test_project_dir.join("readme.md"), "test").unwrap();
        fs::create_dir_all(test_project_dir.join(".git")).unwrap();
        fs::write(test_project_dir.join(".git").join("config"), "test").unwrap();

        let result =
            list_files_with_extensions(&test_project_dir, &["jinja2", "prompt", "j2"]).unwrap();

        assert_eq!(result.len(), 3);
        assert!(result.contains(&"prompts/test.jinja2".to_string()));
        assert!(result.contains(&"prompts/another.prompt".to_string()));
        assert!(result.contains(&"templates/old.j2".to_string()));

        fs::remove_dir_all(&test_project_dir).ok();
    }

    #[tokio::test]
    async fn list_prompt_files_handles_empty_directory() {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_project_dir =
            temp_dir.join(format!("nightshift_empty_prompts_test_{}", unique_id));

        fs::create_dir_all(&test_project_dir).unwrap();

        let result =
            list_files_with_extensions(&test_project_dir, &["jinja2", "prompt", "j2"]).unwrap();

        assert!(result.is_empty());

        fs::remove_dir_all(&test_project_dir).ok();
    }
}
