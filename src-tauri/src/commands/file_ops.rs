use crate::codex_app_server::CodexAppServerManager;
use crate::database::DatabaseState;
use crate::state::AppState;
use crate::utils::{sanitize_name, scan_directory};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

fn root_path(state: &AppState) -> Result<PathBuf, String> {
    let root = state.root_path.lock().unwrap();
    root.as_ref().cloned().ok_or("No folder opened".to_string())
}

fn validate_relative_path(relative_path: &str) -> Result<&Path, String> {
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err("Path outside root folder".to_string());
    }
    Ok(path)
}

fn reject_protected_write_path(relative_path: &str) -> Result<(), String> {
    let normalized = relative_path.replace('\\', "/");
    if is_protected_app_path(&normalized) {
        Err(format!("Writes to '{}' are managed by Nightshift and are not allowed", normalized))
    } else {
        Ok(())
    }
}

fn is_protected_app_path(relative_path: &str) -> bool {
    relative_path == ".git"
        || relative_path.starts_with(".git/")
        || relative_path == ".nightshift"
        || relative_path.starts_with(".nightshift/")
}

fn reject_protected_canonical_path(
    root_canonical: &Path,
    canonical_path: &Path,
) -> Result<(), String> {
    let relative = canonical_path.strip_prefix(root_canonical).unwrap_or(canonical_path);
    let normalized = relative.to_string_lossy().replace('\\', "/");
    if is_protected_app_path(&normalized) {
        Err(format!("Writes to '{}' are managed by Nightshift and are not allowed", normalized))
    } else {
        Ok(())
    }
}

fn reject_existing_protected_write_path(root: &Path, target: &Path) -> Result<(), String> {
    let root_canonical = canonical_root(root)?;
    let target_canonical =
        fs::canonicalize(target).map_err(|e| format!("Failed to resolve path: {}", e))?;
    if !target_canonical.starts_with(&root_canonical) {
        return Err("Path outside root folder".to_string());
    }
    reject_protected_canonical_path(&root_canonical, &target_canonical)
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(root).map_err(|e| format!("Failed to resolve root folder: {}", e))
}

fn existing_path_within_root(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path)?;
    let target = root.join(relative);
    let root_canonical = canonical_root(root)?;
    let target_canonical =
        fs::canonicalize(&target).map_err(|e| format!("Failed to resolve path: {}", e))?;

    if !target_canonical.starts_with(&root_canonical) {
        return Err("Path outside root folder".to_string());
    }

    Ok(target)
}

fn child_path_within_root(
    root: &Path,
    parent_relative_path: &str,
    name: &str,
) -> Result<PathBuf, String> {
    let parent = if parent_relative_path.is_empty() {
        root.to_path_buf()
    } else {
        let relative = validate_relative_path(parent_relative_path)?;
        root.join(relative)
    };

    let root_canonical = canonical_root(root)?;
    let parent_canonical =
        fs::canonicalize(&parent).map_err(|e| format!("Failed to resolve parent folder: {}", e))?;

    if !parent_canonical.starts_with(&root_canonical) {
        return Err("Path outside root folder".to_string());
    }
    reject_protected_canonical_path(&root_canonical, &parent_canonical)?;
    if !parent_canonical.is_dir() {
        return Err("Parent is not a directory".to_string());
    }

    let canonical_child = parent_canonical.join(name);
    reject_protected_canonical_path(&root_canonical, &canonical_child)?;

    Ok(parent.join(name))
}

fn relative_to_root(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string()
}

fn read_file_impl(app_state: &AppState, relative_path: String) -> Result<String, String> {
    let root = root_path(app_state)?;
    let target = existing_path_within_root(&root, &relative_path)?;
    fs::read_to_string(&target).map_err(|e| format!("Failed to read file: {}", e))
}

fn rename_path_impl(
    app_state: &AppState,
    relative_path: String,
    new_name: String,
) -> Result<String, String> {
    let root = root_path(app_state)?;
    reject_protected_write_path(&relative_path)?;
    let new_name = sanitize_name(&new_name)?;
    let old_path = existing_path_within_root(&root, &relative_path)?;
    reject_existing_protected_write_path(&root, &old_path)?;
    let parent = old_path.parent().ok_or("Invalid path".to_string())?;
    let new_path = child_path_within_root(
        &root,
        parent.strip_prefix(&root).unwrap_or(parent).to_string_lossy().as_ref(),
        &new_name,
    )?;

    if new_path.exists() {
        return Err(format!("{} already exists", new_name));
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(relative_to_root(&root, &new_path))
}

fn move_path_impl(
    app_state: &AppState,
    source_relative_path: String,
    target_parent_relative_path: String,
) -> Result<String, String> {
    let root = root_path(app_state)?;
    reject_protected_write_path(&source_relative_path)?;
    reject_protected_write_path(&target_parent_relative_path)?;
    let source = existing_path_within_root(&root, &source_relative_path)?;
    reject_existing_protected_write_path(&root, &source)?;
    let target_parent = if target_parent_relative_path.is_empty() {
        root.clone()
    } else {
        existing_path_within_root(&root, &target_parent_relative_path)?
    };
    reject_existing_protected_write_path(&root, &target_parent)?;

    if !target_parent.is_dir() {
        return Err("Target parent is not a directory".to_string());
    }

    let file_name = source.file_name().ok_or("Invalid source path".to_string())?;
    let dest = target_parent.join(file_name);

    if dest == source {
        return Ok(source_relative_path);
    }
    if dest.exists() {
        return Err(format!("{} already exists in target folder", file_name.to_string_lossy()));
    }

    let source_canonical =
        fs::canonicalize(&source).map_err(|e| format!("Failed to resolve source: {}", e))?;
    if source.is_dir() {
        let target_parent_canonical = fs::canonicalize(&target_parent)
            .map_err(|e| format!("Failed to resolve target parent: {}", e))?;
        if target_parent_canonical.starts_with(&source_canonical) {
            return Err("Cannot move a folder into itself".to_string());
        }
    }

    fs::rename(&source, &dest).map_err(|e| format!("Failed to move: {}", e))?;
    Ok(relative_to_root(&root, &dest))
}

fn delete_path_impl(app_state: &AppState, relative_path: String) -> Result<(), String> {
    let root = root_path(app_state)?;
    reject_protected_write_path(&relative_path)?;
    let target = existing_path_within_root(&root, &relative_path)?;
    reject_existing_protected_write_path(&root, &target)?;

    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete folder: {}", e))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    Ok(())
}

fn copy_file_impl(app_state: &AppState, relative_path: String) -> Result<String, String> {
    let root = root_path(app_state)?;
    reject_protected_write_path(&relative_path)?;
    let source = existing_path_within_root(&root, &relative_path)?;
    reject_existing_protected_write_path(&root, &source)?;

    if !source.is_file() {
        return Err("Can only copy files".to_string());
    }

    let parent = source.parent().ok_or("Invalid source path".to_string())?;
    let file_name =
        source.file_name().ok_or("Invalid source path".to_string())?.to_string_lossy().to_string();
    let dot_pos = file_name.rfind('.');

    let new_name = match dot_pos {
        Some(pos) => format!("{}.copy.{}", &file_name[..pos], &file_name[pos + 1..]),
        None => format!("{}.copy", file_name),
    };

    let dest = parent.join(&new_name);

    if dest.exists() {
        return Err(format!("{} already exists", new_name));
    }

    fs::copy(&source, &dest).map_err(|e| format!("Failed to copy: {}", e))?;
    Ok(relative_to_root(&root, &dest))
}

fn write_file_impl(
    app_state: &AppState,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let root = root_path(app_state)?;
    reject_protected_write_path(&relative_path)?;
    let relative = validate_relative_path(&relative_path)?;
    let target = root.join(relative);
    let parent = target.parent().ok_or("Invalid path".to_string())?;
    let root_canonical = canonical_root(&root)?;
    let parent_canonical =
        fs::canonicalize(parent).map_err(|e| format!("Failed to resolve parent folder: {}", e))?;

    if !parent_canonical.starts_with(&root_canonical) {
        return Err("Path outside root folder".to_string());
    }
    reject_protected_canonical_path(&root_canonical, &parent_canonical)?;
    if target.exists() {
        let target_canonical =
            fs::canonicalize(&target).map_err(|e| format!("Failed to resolve path: {}", e))?;
        if !target_canonical.starts_with(&root_canonical) {
            return Err("Path outside root folder".to_string());
        }
        reject_protected_canonical_path(&root_canonical, &target_canonical)?;
    }

    fs::write(&target, content.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

fn create_folder_impl(
    app_state: &AppState,
    parent_relative_path: String,
    folder_name: String,
) -> Result<String, String> {
    let root = root_path(app_state)?;
    reject_protected_write_path(&parent_relative_path)?;
    let folder_name = sanitize_name(&folder_name)?;
    let new_folder = child_path_within_root(&root, &parent_relative_path, &folder_name)?;

    if new_folder.exists() {
        return Err(format!("{} already exists", folder_name));
    }

    fs::create_dir_all(&new_folder).map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(relative_to_root(&root, &new_folder))
}

fn create_file_impl(
    app_state: &AppState,
    parent_relative_path: String,
    file_name: String,
) -> Result<String, String> {
    let root = root_path(app_state)?;
    reject_protected_write_path(&parent_relative_path)?;
    let file_name = sanitize_name(&file_name)?;
    let new_file = child_path_within_root(&root, &parent_relative_path, &file_name)?;

    if new_file.exists() {
        return Err(format!("{} already exists", file_name));
    }

    fs::write(&new_file, "").map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(relative_to_root(&root, &new_file))
}

/// Scan a folder and set it as the project root. Reconnects the database to
/// the project's `.nightshift/nightshift.db` (creating the directory if needed).
#[tauri::command]
pub async fn scan_folder(
    app: AppHandle,
    app_state: State<'_, AppState>,
    db_state: State<'_, DatabaseState>,
    codex: State<'_, CodexAppServerManager>,
    path: String,
) -> Result<serde_json::Value, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err("Not a valid directory".to_string());
    }

    // Validate + reconnect first; only mirror into AppState on success so a
    // rejection (e.g. opening a subfolder of an existing project) leaves the
    // previous root intact and the two states in sync.
    let previous_root = app_state.root_path.lock().unwrap().clone();
    db_state.reconnect(&path_buf).await?;
    let resolved = db_state.get_project_root();
    {
        let mut root = app_state.root_path.lock().unwrap();
        *root = Some(resolved.clone());
    }
    if previous_root.as_ref() != Some(&resolved) {
        codex.reset_for_project_switch().await;
        emit_project_opened(&app, &resolved);
    }

    let mut file_count = 0usize;
    let children = scan_directory(&resolved, 0, &mut file_count)?;
    Ok(serde_json::json!({
        "name": resolved.file_name().unwrap_or_default().to_string_lossy(),
        "children": children,
    }))
}

/// Set the root path without scanning. Also reconnects the DB pool.
#[tauri::command]
pub async fn set_root_path(
    app: AppHandle,
    app_state: State<'_, AppState>,
    db_state: State<'_, DatabaseState>,
    codex: State<'_, CodexAppServerManager>,
    path: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    let previous_root = app_state.root_path.lock().unwrap().clone();
    db_state.reconnect(&path_buf).await?;
    let resolved = db_state.get_project_root();
    {
        let mut root = app_state.root_path.lock().unwrap();
        *root = Some(resolved.clone());
    }
    if previous_root.as_ref() != Some(&resolved) {
        codex.reset_for_project_switch().await;
        emit_project_opened(&app, &resolved);
    }
    Ok(())
}

/// Notify the frontend that a project root is now available.
fn emit_project_opened(app: &AppHandle, root: &Path) {
    if let Err(e) = app.emit("project-opened", root.to_string_lossy().to_string()) {
        tracing::warn!("Failed to emit project-opened event: {}", e);
    }
}

/// Get the current root path
#[tauri::command]
pub fn get_root_path(state: State<AppState>) -> Option<String> {
    let root = state.root_path.lock().unwrap();
    root.as_ref().map(|p| p.to_string_lossy().to_string())
}

/// Read a file relative to the root path
#[tauri::command]
pub fn read_file(state: State<AppState>, relative_path: String) -> Result<String, String> {
    read_file_impl(&state, relative_path)
}

/// Rename a file or folder
#[tauri::command]
pub fn rename_path(
    state: State<AppState>,
    relative_path: String,
    new_name: String,
) -> Result<String, String> {
    rename_path_impl(&state, relative_path, new_name)
}

/// Move a file or folder into a different directory inside the project.
#[tauri::command]
pub fn move_path(
    state: State<AppState>,
    source_relative_path: String,
    target_parent_relative_path: String,
) -> Result<String, String> {
    move_path_impl(&state, source_relative_path, target_parent_relative_path)
}

/// Delete a file or folder recursively
#[tauri::command]
pub fn delete_path(state: State<AppState>, relative_path: String) -> Result<(), String> {
    delete_path_impl(&state, relative_path)
}

/// Copy a file with ".copy" suffix
#[tauri::command]
pub fn copy_file(state: State<AppState>, relative_path: String) -> Result<String, String> {
    copy_file_impl(&state, relative_path)
}

/// Write content to a file
#[tauri::command]
pub fn write_file(
    state: State<AppState>,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    write_file_impl(&state, relative_path, content)
}

/// Create a new folder
#[tauri::command]
pub fn create_folder(
    state: State<AppState>,
    parent_relative_path: String,
    folder_name: String,
) -> Result<String, String> {
    create_folder_impl(&state, parent_relative_path, folder_name)
}

/// Create a new empty file
#[tauri::command]
pub fn create_file(
    state: State<AppState>,
    parent_relative_path: String,
    file_name: String,
) -> Result<String, String> {
    create_file_impl(&state, parent_relative_path, file_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;
    use uuid::Uuid;

    fn setup_test_dir() -> PathBuf {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = temp_dir.join(format!("nightshift_file_ops_test_{}", unique_id));
        fs::create_dir_all(&test_dir).unwrap();
        test_dir
    }

    #[test]
    fn create_folder_succeeds() {
        let test_dir = setup_test_dir();

        // Create a mock AppState with the test directory as root
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        let result = create_folder_impl(&app_state, "".to_string(), "test_folder".to_string());

        assert!(result.is_ok());
        assert!(test_dir.join("test_folder").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn create_file_succeeds() {
        let test_dir = setup_test_dir();

        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        let result = create_file_impl(&app_state, "".to_string(), "test.txt".to_string());

        assert!(result.is_ok());
        assert!(test_dir.join("test.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn write_file_succeeds() {
        let test_dir = setup_test_dir();

        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        // First create the file
        create_file_impl(&app_state, "".to_string(), "test.txt".to_string()).unwrap();

        // Then write to it
        let result =
            write_file_impl(&app_state, "test.txt".to_string(), "Hello, World!".to_string());

        assert!(result.is_ok());
        let content = fs::read_to_string(test_dir.join("test.txt")).unwrap();
        assert_eq!(content, "Hello, World!");

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn read_file_succeeds() {
        let test_dir = setup_test_dir();

        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        // Create and write a file first
        create_file_impl(&app_state, "".to_string(), "test.txt".to_string()).unwrap();
        fs::write(test_dir.join("test.txt"), "Test content").unwrap();

        let result = read_file_impl(&app_state, "test.txt".to_string());

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Test content");

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn delete_path_succeeds() {
        let test_dir = setup_test_dir();

        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        // Create a file first
        create_file_impl(&app_state, "".to_string(), "test.txt".to_string()).unwrap();
        assert!(test_dir.join("test.txt").exists());

        let result = delete_path_impl(&app_state, "test.txt".to_string());

        assert!(result.is_ok());
        assert!(!test_dir.join("test.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn copy_file_succeeds() {
        let test_dir = setup_test_dir();

        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        // Create a file first
        create_file_impl(&app_state, "".to_string(), "test.txt".to_string()).unwrap();
        fs::write(test_dir.join("test.txt"), "Original content").unwrap();

        let result = copy_file_impl(&app_state, "test.txt".to_string());

        assert!(result.is_ok());
        assert!(test_dir.join("test.copy.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn rename_path_succeeds() {
        let test_dir = setup_test_dir();

        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        // Create a file first
        create_file_impl(&app_state, "".to_string(), "old_name.txt".to_string()).unwrap();

        let result =
            rename_path_impl(&app_state, "old_name.txt".to_string(), "new_name.txt".to_string());

        assert!(result.is_ok());
        assert!(!test_dir.join("old_name.txt").exists());
        assert!(test_dir.join("new_name.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn create_folder_rejects_invalid_names() {
        let test_dir = setup_test_dir();

        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        // Test with ".." in name
        let result = create_folder_impl(&app_state, "".to_string(), "../escape".to_string());

        assert!(result.is_err());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn read_file_rejects_parent_traversal() {
        let test_dir = setup_test_dir();
        let outside_file =
            test_dir.parent().unwrap().join(format!("nightshift_outside_{}.txt", Uuid::new_v4()));
        fs::write(&outside_file, "secret").unwrap();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        let result = read_file_impl(
            &app_state,
            format!("../{}", outside_file.file_name().unwrap().to_string_lossy()),
        );

        assert!(result.is_err());
        fs::remove_file(&outside_file).ok();
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn write_file_rejects_absolute_paths() {
        let test_dir = setup_test_dir();
        let outside_file =
            test_dir.parent().unwrap().join(format!("nightshift_absolute_{}.txt", Uuid::new_v4()));
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        let result = write_file_impl(
            &app_state,
            outside_file.to_string_lossy().to_string(),
            "secret".to_string(),
        );

        assert!(result.is_err());
        assert!(!outside_file.exists());
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn write_file_rejects_protected_app_paths() {
        let test_dir = setup_test_dir();
        fs::create_dir_all(test_dir.join(".nightshift")).unwrap();
        fs::create_dir_all(test_dir.join(".git")).unwrap();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        assert!(write_file_impl(
            &app_state,
            ".nightshift/config.json".to_string(),
            "{}".to_string(),
        )
        .is_err());
        assert!(write_file_impl(&app_state, ".git/config".to_string(), "x".to_string()).is_err());

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn create_folder_rejects_protected_destination_names() {
        let test_dir = setup_test_dir();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        assert!(create_folder_impl(&app_state, "".to_string(), ".nightshift".to_string()).is_err());
        assert!(create_folder_impl(&app_state, "".to_string(), ".git".to_string()).is_err());
        assert!(!test_dir.join(".nightshift").exists());
        assert!(!test_dir.join(".git").exists());

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn create_file_rejects_protected_destination_names() {
        let test_dir = setup_test_dir();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        assert!(create_file_impl(&app_state, "".to_string(), ".nightshift".to_string()).is_err());
        assert!(create_file_impl(&app_state, "".to_string(), ".git".to_string()).is_err());
        assert!(!test_dir.join(".nightshift").exists());
        assert!(!test_dir.join(".git").exists());

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn rename_path_rejects_protected_destination_names() {
        let test_dir = setup_test_dir();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };
        create_folder_impl(&app_state, "".to_string(), "folder".to_string()).unwrap();
        create_file_impl(&app_state, "".to_string(), "file.txt".to_string()).unwrap();

        assert!(
            rename_path_impl(&app_state, "folder".to_string(), ".nightshift".to_string()).is_err()
        );
        assert!(rename_path_impl(&app_state, "file.txt".to_string(), ".git".to_string()).is_err());
        assert!(test_dir.join("folder").exists());
        assert!(test_dir.join("file.txt").exists());
        assert!(!test_dir.join(".nightshift").exists());
        assert!(!test_dir.join(".git").exists());

        fs::remove_dir_all(&test_dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_file_rejects_symlink_to_protected_app_path() {
        use std::os::unix::fs::symlink;

        let test_dir = setup_test_dir();
        fs::create_dir_all(test_dir.join(".nightshift")).unwrap();
        fs::write(test_dir.join(".nightshift/config.json"), "{}").unwrap();
        symlink(test_dir.join(".nightshift/config.json"), test_dir.join("innocent.json")).unwrap();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        let result = write_file_impl(&app_state, "innocent.json".to_string(), "secret".to_string());

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(test_dir.join(".nightshift/config.json")).unwrap(), "{}");
        fs::remove_dir_all(&test_dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn create_file_rejects_symlink_parent_to_protected_app_path() {
        use std::os::unix::fs::symlink;

        let test_dir = setup_test_dir();
        fs::create_dir_all(test_dir.join(".nightshift")).unwrap();
        symlink(test_dir.join(".nightshift"), test_dir.join("metadata")).unwrap();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        let result =
            create_file_impl(&app_state, "metadata".to_string(), "config.json".to_string());

        assert!(result.is_err());
        assert!(!test_dir.join(".nightshift/config.json").exists());
        fs::remove_dir_all(&test_dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn read_file_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let test_dir = setup_test_dir();
        let outside_file = test_dir
            .parent()
            .unwrap()
            .join(format!("nightshift_symlink_target_{}.txt", Uuid::new_v4()));
        fs::write(&outside_file, "secret").unwrap();
        symlink(&outside_file, test_dir.join("link.txt")).unwrap();
        let app_state = AppState { root_path: Mutex::new(Some(test_dir.clone())) };

        let result = read_file_impl(&app_state, "link.txt".to_string());

        assert!(result.is_err());
        fs::remove_file(&outside_file).ok();
        fs::remove_dir_all(&test_dir).ok();
    }
}
