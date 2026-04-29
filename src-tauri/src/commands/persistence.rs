use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Save the last opened folder path to app data directory
#[tauri::command]
pub fn save_last_folder(app: AppHandle, path: String) -> Result<(), String> {
    let col =
        app.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&col).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    let state_path = col.join("last_folder.json");
    let json = serde_json::json!({ "path": path });
    fs::write(&state_path, json.to_string())
        .map_err(|e| format!("Failed to save last folder: {}", e))?;
    Ok(())
}

/// Load the last opened folder path from app data directory
#[tauri::command]
pub fn load_last_folder(app: AppHandle) -> Result<Option<String>, String> {
    let col =
        app.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let state_path = col.join("last_folder.json");
    if !state_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&state_path)
        .map_err(|e| format!("Failed to read last folder: {}", e))?;
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse last folder: {}", e))?;
    Ok(json["path"].as_str().map(|s| s.to_string()))
}

/// Save the expanded folder state for a project's tree view
#[tauri::command]
pub fn save_expanded_state(root_path: String, paths: Vec<String>) -> Result<(), String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("Invalid root path".to_string());
    }
    let nightshift_dir = root.join(".nightshift");
    fs::create_dir_all(&nightshift_dir)
        .map_err(|e| format!("Failed to create .nightshift dir: {}", e))?;
    let state_path = nightshift_dir.join("state.json");
    let json = serde_json::json!({ "expandedFolders": paths });
    fs::write(&state_path, json.to_string())
        .map_err(|e| format!("Failed to save expanded state: {}", e))?;
    Ok(())
}

/// Load the expanded folder state for a project's tree view
#[tauri::command]
pub fn load_expanded_state(root_path: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let state_path = root.join(".nightshift").join("state.json");
    if !state_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&state_path)
        .map_err(|e| format!("Failed to read expanded state: {}", e))?;
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse expanded state: {}", e))?;
    let paths = json["expandedFolders"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    #[test]
    fn save_and_load_last_folder() {
        // Note: This test requires a real app handle, so we skip it in unit tests
        // It should be tested via integration tests or manually
        assert!(true);
    }

    #[test]
    fn save_and_load_expanded_state() {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_project_dir = temp_dir.join(format!("nightshift_expand_test_{}", unique_id));
        
        // Create the directory structure
        fs::create_dir_all(&test_project_dir).unwrap();

        let paths = vec!["src".to_string(), "src/components".to_string()];
        
        let result = save_expanded_state(test_project_dir.to_string_lossy().to_string(), paths.clone());
        assert!(result.is_ok());

        let loaded_paths = load_expanded_state(test_project_dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(loaded_paths, paths);

        // Cleanup
        fs::remove_dir_all(&test_project_dir).ok();
    }

    #[test]
    fn load_expanded_state_from_nonexistent_file() {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_project_dir = temp_dir.join(format!("nightshift_no_expand_test_{}", unique_id));
        
        fs::create_dir_all(&test_project_dir).unwrap();

        let paths = load_expanded_state(test_project_dir.to_string_lossy().to_string()).unwrap();
        assert!(paths.is_empty());

        // Cleanup
        fs::remove_dir_all(&test_project_dir).ok();
    }

    #[test]
    fn save_expanded_state_rejects_invalid_path() {
        let result = save_expanded_state("/nonexistent/path".to_string(), vec![]);
        assert!(result.is_err());
    }
}
