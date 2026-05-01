use std::fs;
use std::path::PathBuf;
use tauri::State;
use crate::database::DatabaseState;
use crate::state::AppState;
use crate::utils::{sanitize_name, scan_directory};

/// Scan a folder and set it as the project root. Reconnects the database to
/// the project's `.nightshift/nightshift.db` (creating the directory if needed).
#[tauri::command]
pub async fn scan_folder(
    app_state: State<'_, AppState>,
    db_state: State<'_, DatabaseState>,
    path: String,
) -> Result<serde_json::Value, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err("Not a valid directory".to_string());
    }

    {
        let mut root = app_state.root_path.lock().unwrap();
        *root = Some(path_buf.clone());
    }
    // Reconnect the DB pool to this project's `.nightshift/`. Updates
    // `db_state.project_root` and atomically swaps the pool inside.
    db_state.reconnect(&path_buf).await?;

    let mut file_count = 0usize;
    let children = scan_directory(&path_buf, 0, &mut file_count)?;
    Ok(serde_json::json!({
        "name": path_buf.file_name().unwrap_or_default().to_string_lossy(),
        "children": children,
    }))
}

/// Set the root path without scanning. Also reconnects the DB pool.
#[tauri::command]
pub async fn set_root_path(
    app_state: State<'_, AppState>,
    db_state: State<'_, DatabaseState>,
    path: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    {
        let mut root = app_state.root_path.lock().unwrap();
        *root = Some(path_buf.clone());
    }
    db_state.reconnect(&path_buf).await
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
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    let target = root.join(&relative_path);

    if !target.starts_with(root) {
        return Err("Path outside root folder".to_string());
    }

    fs::read_to_string(&target).map_err(|e| format!("Failed to read file: {}", e))
}

/// Rename a file or folder
#[tauri::command]
pub fn rename_path(
    state: State<AppState>,
    relative_path: String,
    new_name: String,
) -> Result<String, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    let new_name = sanitize_name(&new_name)?;
    let old_path = root.join(&relative_path);
    let parent = old_path.parent().ok_or("Invalid path".to_string())?.to_path_buf();
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(format!("{} already exists", new_name));
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(new_path.strip_prefix(root).unwrap_or(&new_path).to_string_lossy().to_string())
}

/// Move a file or folder into a different parent directory inside the project.
/// `target_parent_relative_path` is empty-string for the project root.
/// Both the source and resolved destination must stay inside the project root.
#[tauri::command]
pub fn move_path(
    state: State<AppState>,
    source_relative_path: String,
    target_parent_relative_path: String,
) -> Result<String, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;

    let source = root.join(&source_relative_path);
    if !source.starts_with(root) {
        return Err("Source outside project root".to_string());
    }
    if !source.exists() {
        return Err("Source does not exist".to_string());
    }

    let target_parent = if target_parent_relative_path.is_empty() {
        root.clone()
    } else {
        root.join(&target_parent_relative_path)
    };
    if !target_parent.starts_with(root) {
        return Err("Target outside project root".to_string());
    }
    if !target_parent.is_dir() {
        return Err("Target parent is not a directory".to_string());
    }

    let file_name = source.file_name().ok_or("Invalid source path".to_string())?;
    let dest = target_parent.join(file_name);

    if dest == source {
        // Already there — nothing to do.
        return Ok(source_relative_path);
    }
    if dest.exists() {
        return Err(format!("{} already exists in target folder", file_name.to_string_lossy()));
    }

    // Disallow moving a directory into itself or its descendants.
    if source.is_dir() && dest.starts_with(&source) {
        return Err("Cannot move a folder into itself".to_string());
    }

    fs::rename(&source, &dest).map_err(|e| format!("Failed to move: {}", e))?;
    Ok(dest.strip_prefix(root).unwrap_or(&dest).to_string_lossy().to_string())
}

/// Delete a file or folder recursively
#[tauri::command]
pub fn delete_path(state: State<AppState>, relative_path: String) -> Result<(), String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    let target = root.join(&relative_path);

    if !target.starts_with(root) {
        return Err("Path outside root folder".to_string());
    }

    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete folder: {}", e))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    Ok(())
}

/// Copy a file with ".copy" suffix
#[tauri::command]
pub fn copy_file(state: State<AppState>, relative_path: String) -> Result<String, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    let source = root.join(&relative_path);

    if !source.is_file() {
        return Err("Can only copy files".to_string());
    }

    let parent = source.parent().unwrap();
    let file_name = source.file_name().unwrap().to_string_lossy().to_string();
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

    Ok(dest.strip_prefix(root).unwrap_or(&dest).to_string_lossy().to_string())
}

/// Write content to a file
#[tauri::command]
pub fn write_file(
    state: State<AppState>,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    let target = root.join(&relative_path);

    if !target.starts_with(root) {
        return Err("Path outside root folder".to_string());
    }

    fs::write(&target, content.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(())
}

/// Create a new folder
#[tauri::command]
pub fn create_folder(
    state: State<AppState>,
    parent_relative_path: String,
    folder_name: String,
) -> Result<String, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;

    let folder_name = sanitize_name(&folder_name)?;

    let parent_path = if parent_relative_path.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&parent_relative_path)
    };

    let new_folder = parent_path.join(&folder_name);

    if !new_folder.starts_with(root) {
        return Err("Path outside root folder".to_string());
    }

    if new_folder.exists() {
        return Err(format!("{} already exists", folder_name));
    }

    fs::create_dir_all(&new_folder).map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(new_folder.strip_prefix(root).unwrap_or(&new_folder).to_string_lossy().to_string())
}

/// Create a new empty file
#[tauri::command]
pub fn create_file(
    state: State<AppState>,
    parent_relative_path: String,
    file_name: String,
) -> Result<String, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;

    let file_name = sanitize_name(&file_name)?;

    let parent_path = if parent_relative_path.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&parent_relative_path)
    };

    let new_file = parent_path.join(&file_name);

    if !new_file.starts_with(root) {
        return Err("Path outside root folder".to_string());
    }

    if new_file.exists() {
        return Err(format!("{} already exists", file_name));
    }

    fs::write(&new_file, "").map_err(|e| format!("Failed to create file: {}", e))?;

    Ok(new_file.strip_prefix(root).unwrap_or(&new_file).to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use super::*;
    use std::env;
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
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        let result = create_folder(
            State(&app_state),
            "".to_string(),
            "test_folder".to_string(),
        );

        assert!(result.is_ok());
        assert!(test_dir.join("test_folder").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn create_file_succeeds() {
        let test_dir = setup_test_dir();
        
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        let result = create_file(
            State(&app_state),
            "".to_string(),
            "test.txt".to_string(),
        );

        assert!(result.is_ok());
        assert!(test_dir.join("test.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn write_file_succeeds() {
        let test_dir = setup_test_dir();
        
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        // First create the file
        create_file(State(&app_state), "".to_string(), "test.txt".to_string()).unwrap();

        // Then write to it
        let result = write_file(
            State(&app_state),
            "test.txt".to_string(),
            "Hello, World!".to_string(),
        );

        assert!(result.is_ok());
        let content = fs::read_to_string(test_dir.join("test.txt")).unwrap();
        assert_eq!(content, "Hello, World!");

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn read_file_succeeds() {
        let test_dir = setup_test_dir();
        
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        // Create and write a file first
        create_file(State(&app_state), "".to_string(), "test.txt".to_string()).unwrap();
        fs::write(test_dir.join("test.txt"), "Test content").unwrap();

        let result = read_file(State(&app_state), "test.txt".to_string());

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Test content");

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn delete_path_succeeds() {
        let test_dir = setup_test_dir();
        
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        // Create a file first
        create_file(State(&app_state), "".to_string(), "test.txt".to_string()).unwrap();
        assert!(test_dir.join("test.txt").exists());

        let result = delete_path(State(&app_state), "test.txt".to_string());

        assert!(result.is_ok());
        assert!(!test_dir.join("test.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn copy_file_succeeds() {
        let test_dir = setup_test_dir();
        
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        // Create a file first
        create_file(State(&app_state), "".to_string(), "test.txt".to_string()).unwrap();
        fs::write(test_dir.join("test.txt"), "Original content").unwrap();

        let result = copy_file(State(&app_state), "test.txt".to_string());

        assert!(result.is_ok());
        assert!(test_dir.join("test.copy.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn rename_path_succeeds() {
        let test_dir = setup_test_dir();
        
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        // Create a file first
        create_file(State(&app_state), "".to_string(), "old_name.txt".to_string()).unwrap();

        let result = rename_path(
            State(&app_state),
            "old_name.txt".to_string(),
            "new_name.txt".to_string(),
        );

        assert!(result.is_ok());
        assert!(!test_dir.join("old_name.txt").exists());
        assert!(test_dir.join("new_name.txt").exists());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn create_folder_rejects_invalid_names() {
        let test_dir = setup_test_dir();
        
        let app_state = AppState {
            root_path: Mutex::new(Some(test_dir.clone())),
        };

        // Test with ".." in name
        let result = create_folder(
            State(&app_state),
            "".to_string(),
            "../escape".to_string(),
        );

        assert!(result.is_err());

        // Cleanup
        fs::remove_dir_all(&test_dir).ok();
    }
}
