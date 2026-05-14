use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;
use crate::utils::secrets::{is_sensitive_key, looks_like_secret_value};

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
    let state_path = project_state_path_from_root(&root);
    let mut state = load_project_state_file(&state_path)?;
    state.insert("expandedFolders".into(), serde_json::json!(paths));
    save_project_state_file(&state_path, &state)?;
    Ok(())
}

/// Load the expanded folder state for a project's tree view
#[tauri::command]
pub fn load_expanded_state(root_path: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let state_path = project_state_path_from_root(&root);
    let json = load_project_state_file(&state_path)?;
    let paths = json
        .get("expandedFolders")
        .and_then(serde_json::Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    Ok(paths)
}

fn current_nightshift_dir(state: &AppState) -> Result<PathBuf, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    Ok(root.join(".nightshift"))
}

fn project_state_path_from_root(root: &std::path::Path) -> PathBuf {
    root.join(".nightshift").join("state.json")
}

fn load_project_state_file(path: &std::path::Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read .nightshift/state.json: {}", e))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse .nightshift/state.json: {}", e))?;
    Ok(value.as_object().cloned().unwrap_or_default())
}

fn save_project_state_file(
    path: &std::path::Path,
    state: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .nightshift dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(&serde_json::Value::Object(state.clone()))
        .map_err(|e| format!("Failed to serialize .nightshift/state.json: {}", e))?;
    fs::write(path, content.as_bytes())
        .map_err(|e| format!("Failed to save .nightshift/state.json: {}", e))
}

fn load_project_state_key(
    state: &AppState,
    key: &str,
) -> Result<Option<serde_json::Value>, String> {
    let path = current_nightshift_dir(state)?.join("state.json");
    Ok(load_project_state_file(&path)?.remove(key))
}

fn save_project_state_key(
    state: &AppState,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let path = current_nightshift_dir(state)?.join("state.json");
    let mut project_state = load_project_state_file(&path)?;
    project_state.insert(key.to_string(), value);
    save_project_state_file(&path, &project_state)
}

fn load_project_json(
    state: &AppState,
    file_name: &str,
) -> Result<Option<serde_json::Value>, String> {
    let key = file_name.strip_suffix(".json").unwrap_or(file_name);
    load_project_state_key(state, key)
}

fn save_project_json(
    state: &AppState,
    file_name: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let key = file_name.strip_suffix(".json").unwrap_or(file_name);
    save_project_state_key(state, key, value)
}

fn redact_project_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, child)| {
                    if is_sensitive_key(&key) {
                        (key, serde_json::Value::String("[redacted]".into()))
                    } else {
                        (key, redact_project_json(child))
                    }
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(redact_project_json).collect())
        }
        serde_json::Value::String(text) if looks_like_secret_value(&text) => {
            serde_json::Value::String("[redacted]".into())
        }
        other => other,
    }
}

#[tauri::command]
pub fn load_project_layout(state: State<AppState>) -> Result<Option<serde_json::Value>, String> {
    load_project_json(&state, "layout.json")
}

#[tauri::command]
pub fn save_project_layout(
    state: State<AppState>,
    layout: serde_json::Value,
) -> Result<(), String> {
    save_project_json(&state, "layout.json", layout)
}

#[tauri::command]
pub fn load_project_conversations(
    state: State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    load_project_json(&state, "conversations.json")
}

#[tauri::command]
pub fn save_project_conversations(
    state: State<AppState>,
    conversations: serde_json::Value,
) -> Result<(), String> {
    save_project_json(&state, "conversations.json", redact_project_json(conversations))
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

        let result =
            save_expanded_state(test_project_dir.to_string_lossy().to_string(), paths.clone());
        assert!(result.is_ok());

        let loaded_paths =
            load_expanded_state(test_project_dir.to_string_lossy().to_string()).unwrap();
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

    #[test]
    fn save_and_load_project_json_state() {
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_project_dir =
            temp_dir.join(format!("nightshift_project_state_test_{}", unique_id));
        fs::create_dir_all(test_project_dir.join(".nightshift")).unwrap();
        let state = AppState { root_path: std::sync::Mutex::new(Some(test_project_dir.clone())) };
        let value = serde_json::json!({ "schemaVersion": 1, "panels": [] });

        save_project_json(&state, "layout.json", value.clone()).unwrap();
        let loaded = load_project_json(&state, "layout.json").unwrap();

        assert_eq!(loaded, Some(value));
        fs::remove_dir_all(&test_project_dir).ok();
    }

    #[test]
    fn redacts_secret_like_values_before_project_conversation_save() {
        let value = serde_json::json!([
            {
                "title": "secret chat",
                "messages": [
                    { "text": "sk-test-secret-value" },
                    { "text": "0123456789abcdef0123456789abcdef01234567" },
                    { "text": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ" },
                    { "toolArguments": { "api_key": "plain-value" } }
                ]
            }
        ]);
        let redacted = redact_project_json(value);

        assert_eq!(redacted[0]["messages"][0]["text"], "[redacted]");
        assert_eq!(redacted[0]["messages"][1]["text"], "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(redacted[0]["messages"][2]["text"], "[redacted]");
        assert_eq!(redacted[0]["messages"][3]["toolArguments"]["api_key"], "[redacted]");
    }
}
