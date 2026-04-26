#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

struct AppState {
    root_path: std::sync::Mutex<Option<PathBuf>>,
}

const TEXT_EXTENSIONS: &[&str] = &[
    "js", "json", "jsonl", "yaml", "yml", "csv", "md", "markdown", "txt", "jinja", "jinja2",
];

const MAX_SCAN_DEPTH: u32 = 12;
const MAX_ENTRIES_PER_DIR: usize = 1_000;

fn is_text_file(filename: &str) -> bool {
    if let Some(ext) = filename.rsplit('.').next() {
        return TEXT_EXTENSIONS.contains(&ext.to_lowercase().as_str());
    }
    return false;
}

fn sanitize_name(name: &str) -> Result<String, String> {
    let sanitized = name.replace('\0', "");
    if sanitized.contains("..") || sanitized != name && name.contains('\0') {
        return Err("Invalid name: contains null bytes or \"..\" sequence".to_string());
    }
    if sanitized.is_empty() {
        return Err("Invalid name: empty after sanitization".to_string());
    }
    Ok(sanitized)
}

fn scan_directory(
    dir: &Path,
    depth: u32,
    file_count: &mut usize,
) -> Result<Vec<serde_json::Value>, String> {
    if depth > MAX_SCAN_DEPTH {
        return Err(format!(
            "Maximum directory scan depth ({}) exceeded",
            MAX_SCAN_DEPTH
        ));
    }

    let mut entries = Vec::new();

    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        if metadata.is_dir() {
            let children = scan_directory(&path, depth + 1, file_count)?;
            entries.push(serde_json::json!({
                "name": name,
                "isDir": true,
                "children": children,
            }));
        } else if is_text_file(&name) {
            *file_count += 1;
            if *file_count > MAX_ENTRIES_PER_DIR {
                return Err(format!(
                    "Too many files scanned (limit: {}). Directory may contain node_modules or similar.",
                    MAX_ENTRIES_PER_DIR
                ));
            }
            entries.push(serde_json::json!({
                "name": name,
                "isDir": false,
            }));
        }
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        let a_dir = a["isDir"].as_bool().unwrap_or(false);
        let b_dir = b["isDir"].as_bool().unwrap_or(false);
        if a_dir != b_dir {
            return if a_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });

    Ok(entries)
}

#[tauri::command]
fn scan_folder(state: State<AppState>, path: String) -> Result<serde_json::Value, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err("Not a valid directory".to_string());
    }

    let mut root = state.root_path.lock().unwrap();
    *root = Some(path_buf.clone());

    let mut file_count = 0usize;
    let children = scan_directory(&path_buf, 0, &mut file_count)?;
    Ok(serde_json::json!({
        "name": path_buf.file_name().unwrap_or_default().to_string_lossy(),
        "children": children,
    }))
}

#[tauri::command]
fn set_root_path(state: State<AppState>, path: String) {
    let mut root = state.root_path.lock().unwrap();
    *root = Some(PathBuf::from(path));
}

#[tauri::command]
fn get_root_path(state: State<AppState>) -> Option<String> {
    let root = state.root_path.lock().unwrap();
    root.as_ref().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn read_file(state: State<AppState>, relative_path: String) -> Result<String, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    let target = root.join(&relative_path);

    if !target.starts_with(root) {
        return Err("Path outside root folder".to_string());
    }

    fs::read_to_string(&target).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn rename_path(
    state: State<AppState>,
    relative_path: String,
    new_name: String,
) -> Result<String, String> {
    let root = state.root_path.lock().unwrap();
    let root = root.as_ref().ok_or("No folder opened".to_string())?;
    let new_name = sanitize_name(&new_name)?;
    let old_path = root.join(&relative_path);
    let parent = old_path
        .parent()
        .ok_or("Invalid path".to_string())?
        .to_path_buf();
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(format!("{} already exists", new_name));
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(new_path
        .strip_prefix(root)
        .unwrap_or(&new_path)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn delete_path(state: State<AppState>, relative_path: String) -> Result<(), String> {
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

#[tauri::command]
fn copy_file(state: State<AppState>, relative_path: String) -> Result<String, String> {
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

    Ok(dest
        .strip_prefix(root)
        .unwrap_or(&dest)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn write_file(
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

#[tauri::command]
fn create_folder(
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

    Ok(new_folder
        .strip_prefix(root)
        .unwrap_or(&new_folder)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn create_file(
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

    Ok(new_file
        .strip_prefix(root)
        .unwrap_or(&new_file)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn save_last_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let col = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&col).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    let state_path = col.join("last_folder.json");
    let json = serde_json::json!({ "path": path });
    fs::write(&state_path, json.to_string())
        .map_err(|e| format!("Failed to save last folder: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_last_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let col = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
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

#[tauri::command]
fn save_expanded_state(root_path: String, paths: Vec<String>) -> Result<(), String> {
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

#[tauri::command]
fn load_expanded_state(root_path: String) -> Result<Vec<String>, String> {
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
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(paths)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            root_path: std::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            set_root_path,
            get_root_path,
            read_file,
            rename_path,
            delete_path,
            copy_file,
            write_file,
            create_folder,
            create_file,
            save_last_folder,
            load_last_folder,
            save_expanded_state,
            load_expanded_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nightshift");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_rejects_null_bytes() {
        assert!(sanitize_name("foo\0bar").is_err());
    }

    #[test]
    fn sanitize_name_rejects_dotdot() {
        assert!(sanitize_name("foo/../bar").is_err());
        assert!(sanitize_name("..").is_err());
        assert!(sanitize_name("foo..bar").is_ok()); // ".." not as path separator is fine
    }

    #[test]
    fn sanitize_name_rejects_empty() {
        assert!(sanitize_name("").is_err());
    }

    #[test]
    fn sanitize_name_accepts_valid_names() {
        assert_eq!(sanitize_name("valid_file.txt").unwrap(), "valid_file.txt");
        assert_eq!(sanitize_name(".env").unwrap(), ".env");
        assert_eq!(sanitize_name("folder-name").unwrap(), "folder-name");
    }

    #[test]
    fn scan_directory_respects_depth_limit() {
        let dir = std::env::temp_dir();
        let deep_path = dir.join(format!("nightshift_depth_test_{}", std::process::id()));
        let mut current = deep_path.clone();
        for i in 0..=MAX_SCAN_DEPTH {
            current = current.join(format!("level_{}", i));
        }
        fs::create_dir_all(&current).ok();

        let result = scan_directory(&deep_path, 0, &mut 0usize);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Maximum directory scan depth"));

        fs::remove_dir_all(&deep_path).ok();
    }

    #[test]
    fn scan_directory_respects_file_count_limit() {
        let dir = std::env::temp_dir();
        let test_dir = dir.join(format!("nightshift_count_test_{}", std::process::id()));
        fs::create_dir_all(&test_dir).ok();

        for i in 0..=MAX_ENTRIES_PER_DIR {
            fs::write(test_dir.join(format!("file_{}.txt", i)), "").ok();
        }

        let result = scan_directory(&test_dir, 0, &mut 0usize);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Too many files scanned"));

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_succeeds_within_limits() {
        let dir = std::env::temp_dir();
        let test_dir = dir.join(format!("nightshift_ok_test_{}", std::process::id()));
        fs::create_dir_all(&test_dir).ok();

        fs::write(test_dir.join("a.txt"), "").ok();
        fs::write(test_dir.join("b.json"), "").ok();
        fs::create_dir_all(test_dir.join("subdir")).ok();
        fs::write(test_dir.join("subdir").join("c.md"), "").ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(count, 3); // a.txt, b.json, subdir/c.md

        fs::remove_dir_all(&test_dir).ok();
    }
}
