#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

struct AppState {
    root_path: std::sync::Mutex<Option<PathBuf>>,
}

const TEXT_EXTENSIONS: &[&str] = &[
    "js", "json", "jsonl", "yaml", "yml", "csv", "md", "markdown", "txt", "jinja", "jinja2",
];

fn is_text_file(filename: &str) -> bool {
    if let Some(ext) = filename.rsplit('.').next() {
        return TEXT_EXTENSIONS.contains(&ext.to_lowercase().as_str());
    }
    // Include files with no extension that are common config files
    let lower = filename.to_lowercase();
    lower.contains("dockerfile")
        || lower.contains("makefile")
        || lower == ".env"
        || lower.starts_with(".git")
}

fn scan_directory(dir: &Path) -> Result<Vec<serde_json::Value>, String> {
    let mut entries = Vec::new();

    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        if metadata.is_dir() {
            let children = scan_directory(&path)?;
            entries.push(serde_json::json!({
                "name": name,
                "isDir": true,
                "children": children,
            }));
        } else if is_text_file(&name) {
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

    let children = scan_directory(&path_buf)?;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running nightshift");
}
