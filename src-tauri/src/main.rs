#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

mod database;
use database::{DatabaseState, create_inference_job, get_inference_job, list_inference_jobs, update_inference_job, delete_inference_job, create_collection, add_collection_item, get_collection_items, get_collection_count};

mod job_executor;
use job_executor::{JobExecutor, JobEvent, WorkerConfig};

use tokio::sync::Mutex as TokioMutex;

struct AppState {
    root_path: Mutex<Option<PathBuf>>,
}

struct JobManager {
    executor: TokioMutex<Option<JobExecutor>>,
}

const TEXT_EXTENSIONS: &[&str] =
    &["js", "json", "jsonl", "yaml", "yml", "csv", "md", "markdown", "txt", "jinja", "jinja2"];

const MAX_SCAN_DEPTH: u32 = 12;
const MAX_ENTRIES_PER_DIR: usize = 1_000;

fn is_text_file(filename: &str) -> bool {
    if let Some(ext) = filename.rsplit('.').next() {
        return TEXT_EXTENSIONS.contains(&ext.to_lowercase().as_str());
    }
    false
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
        return Err(format!("Maximum directory scan depth ({}) exceeded", MAX_SCAN_DEPTH));
    }

    let mut entries = Vec::new();

    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;
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
            return if a_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
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
    let parent = old_path.parent().ok_or("Invalid path".to_string())?.to_path_buf();
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(format!("{} already exists", new_name));
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(new_path.strip_prefix(root).unwrap_or(&new_path).to_string_lossy().to_string())
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

    Ok(dest.strip_prefix(root).unwrap_or(&dest).to_string_lossy().to_string())
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

    Ok(new_folder.strip_prefix(root).unwrap_or(&new_folder).to_string_lossy().to_string())
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

    Ok(new_file.strip_prefix(root).unwrap_or(&new_file).to_string_lossy().to_string())
}

#[tauri::command]
fn save_last_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let col =
        app.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&col).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    let state_path = col.join("last_folder.json");
    let json = serde_json::json!({ "path": path });
    fs::write(&state_path, json.to_string())
        .map_err(|e| format!("Failed to save last folder: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_last_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
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
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    Ok(paths)
}

#[tauri::command]
async fn start_inference_job(
    job_manager: State<'_, JobManager>,
    db: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<(), String> {
    // Initialize executor if not already done
    let mut executor_opt = job_manager.executor.lock().await;
    if executor_opt.is_none() {
        *executor_opt = Some(JobExecutor::new(db.clone()));
    }
    
    let executor = executor_opt.as_ref().unwrap();
    
    // Start the job
    executor.start_job(job_id).await?;
    
    Ok(())
}

#[tauri::command]
async fn cancel_inference_job(
    job_manager: State<'_, JobManager>,
    db: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<bool, String> {
    // Initialize executor if not already done
    let mut executor_opt = job_manager.executor.lock().await;
    if executor_opt.is_none() {
        *executor_opt = Some(JobExecutor::new(db.clone()));
    }
    
    let executor = executor_opt.as_ref().unwrap();
    
    // Cancel the job
    let cancelled = executor.cancel_job(job_id).await?;
    
    Ok(cancelled)
}

#[tauri::command]
async fn subscribe_to_job_status(
    app: tauri::AppHandle,
    job_manager: State<'_, JobManager>,
    db: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<(), String> {
    use tokio::sync::mpsc;

    // Initialize executor if not already done
    let mut executor_opt = job_manager.executor.lock().await;
    if executor_opt.is_none() {
        *executor_opt = Some(JobExecutor::new(db.clone()));
    }
    
    let executor = executor_opt.as_ref().unwrap();
    
    // Get job config
    let job = crate::database::get_inference_job(db.clone(), job_id).await
        .map_err(|e| format!("Failed to get job: {}", e))?;
    
    let job = job.ok_or("Job not found")?;
    let config = WorkerConfig::from_job(job);
    
    // Create channel for events
    let (tx, mut rx) = mpsc::channel::<JobEvent>(100);
    
    // Clone app for event emission
    let app_clone = app.clone();
    
    // Spawn task to receive and broadcast events
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let event_name = match &event {
                JobEvent::Started { .. } => "job-started",
                JobEvent::SampleStarted { .. } => "sample-started",
                JobEvent::SampleCompleted { .. } => "sample-completed",
                JobEvent::SampleFailed { .. } => "sample-failed",
                JobEvent::ProgressUpdate(_) => "job-progress",
                JobEvent::Completed { .. } => "job-completed",
                JobEvent::Failed { .. } => "job-failed",
                JobEvent::Cancelled { .. } => "job-cancelled",
            };
            
            if let Err(e) = app_clone.emit(event_name, event) {
                tracing::warn!("Failed to emit job event: {}", e);
            }
        }
    });
    
    // Start execution in background
    let executor_clone = executor.clone();
    tokio::spawn(async move {
        if let Err(e) = executor_clone.execute_job(config, tx).await {
            tracing::error!("Job execution failed: {}", e);
        }
    });
    
    Ok(())
}

fn main() {
    // Initialize tracing subscriber
    tracing_subscriber::fmt::init();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { root_path: std::sync::Mutex::new(None) })
        .manage(JobManager {
            executor: TokioMutex::new(None),
        })
        .setup(|app| {
            // Initialize database connection with project-based path
            // Use current working directory as default project location
            let project_path = std::env::current_dir()
                .expect("Failed to get current working directory");

            // Initialize database connection using tokio runtime
            #[cfg(not(target_os = "android"))]
            {
                let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
                match rt.block_on(DatabaseState::new(&project_path)) {
                    Ok(db_state) => { app.manage(db_state); }
                    Err(e) => {
                        eprintln!("Failed to initialize database for project at {:?}: {}", project_path, e);
                        eprintln!("Make sure the project has a .nightshift directory or create one.");
                        std::process::exit(1);
                    }
                }
            }

            Ok(())
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
            // Database commands
            create_inference_job,
            get_inference_job,
            list_inference_jobs,
            update_inference_job,
            delete_inference_job,
            create_collection,
            add_collection_item,
            get_collection_items,
            get_collection_count,
            // Job execution commands
            start_inference_job,
            cancel_inference_job,
            subscribe_to_job_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nightshift");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{InferenceJob, InferenceJobInput, CollectionItem};
    use uuid::Uuid;

    #[test]
    fn sanitize_name_rejects_null_bytes() {
        assert!(sanitize_name("foo\0bar").is_err());
    }

    #[test]
    fn sanitize_name_rejects_dotdot() {
        assert!(sanitize_name("foo/../bar").is_err());
        assert!(sanitize_name("..").is_err());
        assert!(sanitize_name("foo..bar").is_err()); // ".." anywhere is rejected
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
        let unique_id = Uuid::new_v4().to_string();
        let deep_path = dir.join(format!("nightshift_depth_test_{}", unique_id));
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
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_count_test_{}", unique_id));
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
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_ok_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        fs::write(test_dir.join("a.txt"), "").ok();
        fs::write(test_dir.join("b.json"), "").ok();
        fs::create_dir_all(test_dir.join("subdir")).ok();
        fs::write(test_dir.join("subdir").join("c.md"), "").ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let _entries = result.unwrap();
        assert_eq!(count, 3); // a.txt, b.json, subdir/c.md

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn is_text_file_returns_true_for_known_extensions() {
        assert!(is_text_file("file.js"));
        assert!(is_text_file("file.json"));
        assert!(is_text_file("file.jsonl"));
        assert!(is_text_file("file.yaml"));
        assert!(is_text_file("file.yml"));
        assert!(is_text_file("file.csv"));
        assert!(is_text_file("file.md"));
        assert!(is_text_file("file.markdown"));
        assert!(is_text_file("file.txt"));
        assert!(is_text_file("file.jinja"));
        assert!(is_text_file("file.jinja2"));
    }

    #[test]
    fn is_text_file_returns_false_for_binary_extensions() {
        assert!(!is_text_file("file.png"));
        assert!(!is_text_file("file.jpg"));
        assert!(!is_text_file("file.exe"));
        assert!(!is_text_file("file.zip"));
        assert!(!is_text_file("file.pdf"));
    }

    #[test]
    fn is_text_file_returns_false_for_no_extension() {
        assert!(!is_text_file("README"));
        assert!(!is_text_file(".gitignore"));
    }

    #[test]
    fn is_text_file_handles_uppercase_extensions() {
        assert!(is_text_file("file.TXT"));
        assert!(is_text_file("file.JSON"));
        assert!(is_text_file("file.MD"));
    }

    #[test]
    fn is_text_file_handles_multiple_dots() {
        assert!(is_text_file("file.test.js"));
        assert!(is_text_file("data.backup.json"));
    }

    #[test]
    fn sanitize_name_strips_null_bytes() {
        let result = sanitize_name("foo\0bar");
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_name_handles_only_null_bytes() {
        assert!(sanitize_name("\0\0").is_err());
    }

    #[test]
    fn sanitize_name_handles_unicode() {
        assert!(sanitize_name("файл.txt").is_ok());
        assert!(sanitize_name("文件.md").is_ok());
    }

    #[test]
    fn sanitize_name_handles_special_chars() {
        assert!(sanitize_name("file-name.txt").is_ok());
        assert!(sanitize_name("file_name.txt").is_ok());
        assert!(sanitize_name(".hidden").is_ok());
    }

    #[test]
    fn scan_directory_sorts_directories_first() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_sort_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        fs::write(test_dir.join("b.txt"), "").ok();
        fs::write(test_dir.join("a.txt"), "").ok();
        fs::create_dir_all(test_dir.join("z_dir")).ok();
        fs::create_dir_all(test_dir.join("a_dir")).ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let entries = result.unwrap();

        // Directories should come first, then files, both alphabetical
        assert!(entries[0]["isDir"].as_bool().unwrap());
        assert_eq!(entries[0]["name"].as_str().unwrap(), "a_dir");
        assert!(entries[1]["isDir"].as_bool().unwrap());
        assert_eq!(entries[1]["name"].as_str().unwrap(), "z_dir");
        assert!(!entries[2]["isDir"].as_bool().unwrap());
        assert_eq!(entries[2]["name"].as_str().unwrap(), "a.txt");

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_handles_empty_directory() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_empty_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 0);
        assert_eq!(count, 0);

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_skips_binary_files() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_binary_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        fs::write(test_dir.join("file.txt"), "").ok();
        fs::write(test_dir.join("image.png"), "").ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 1); // Only .txt should appear
        assert_eq!(count, 1);

        fs::remove_dir_all(&test_dir).ok();
    }

     #[test]
     fn scan_directory_handles_nested_directories() {
         let dir = std::env::temp_dir();
         let unique_id = Uuid::new_v4().to_string();
         let test_dir = dir.join(format!("nightshift_nested_test_{}", unique_id));
         fs::create_dir_all(&test_dir).ok();

         fs::create_dir_all(test_dir.join("a").join("b").join("c")).ok();
         fs::write(test_dir.join("a").join("b").join("c").join("deep.txt"), "content").ok();

         let mut count = 0usize;
         let result = scan_directory(&test_dir, 0, &mut count);
         assert!(result.is_ok());
         let _entries = result.unwrap();
         assert_eq!(count, 1);

         fs::remove_dir_all(&test_dir).ok();
     }

     #[tokio::test]
     async fn test_database_schema_creation() {
         // Create a temporary directory with .nightshift folder to simulate a project
         let temp_dir = std::env::temp_dir();
         let unique_id = Uuid::new_v4().to_string();
         let test_project_dir = temp_dir.join(format!("nightshift_test_project_{}", unique_id));
         let nightshift_dir = test_project_dir.join(".nightshift");

         // Create .nightshift directory
         std::fs::create_dir_all(&nightshift_dir).expect("Failed to create .nightshift dir");

         // Initialize database (will find project root and create db in .nightshift)
         let _db_state = DatabaseState::new(&test_project_dir).await.expect("Failed to initialize database");

         // Verify database was created in the right location
         let expected_db_path = nightshift_dir.join("nightshift.db");
         assert!(expected_db_path.exists(), "Database should be created in .nightshift folder");

         // Clean up
         let _ = std::fs::remove_dir_all(&test_project_dir);

         // If we got here without error, the schema was created successfully
         assert!(true);
     }

     #[tokio::test]
     async fn test_inference_job_crud_operations() {
         // Create a temporary directory with .nightshift folder to simulate a project
         let temp_dir = std::env::temp_dir();
         let unique_id = Uuid::new_v4().to_string();
         let test_project_dir = temp_dir.join(format!("nightshift_test_project_{}", unique_id));
         let nightshift_dir = test_project_dir.join(".nightshift");

         // Create .nightshift directory
         std::fs::create_dir_all(&nightshift_dir).expect("Failed to create .nightshift dir");

         // Initialize database (will find project root and create db in .nightshift)
         let db_state = DatabaseState::new(&test_project_dir).await.expect("Failed to initialize database");

         // Test create job - call directly on pool instead of through Tauri command
         let input = InferenceJobInput {
             name: "Test Job".to_string(),
             prompt_file: "test.jinja2".to_string(),
             data_source: "data.jsonl".to_string(),
             provider: "Local".to_string(),
             model: "test-model".to_string(),
             server_url: "http://localhost:8000".to_string(),
             output_mode: "JSON".to_string(),
             temperature: Some(0.7),
             max_tokens: Some(1000),
             thinking_budget: Some(500),
             samples: 10,
             strategy: "random".to_string(),
             pre_render_url: Some("http://example.com/api".to_string()),
             pre_render_timeout: Some(30),
             pre_render_body: Some(r#"{"query": "test"}"#.to_string()),
             json_schema_file: Some("schema.json".to_string()),
         };

         // Validate input
         assert!(!input.name.trim().is_empty());
         assert!(input.samples > 0);

         let result = sqlx::query(
             r#"
             INSERT INTO inference_jobs (
                 name, prompt_file, data_source, provider, model, server_url,
                 output_mode, temperature, max_tokens, thinking_budget, samples, strategy,
                 pre_render_url, pre_render_timeout, pre_render_body, json_schema_file, status
             )
             VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'pending'
             )
             "#,
         )
         .bind(&input.name)
         .bind(&input.prompt_file)
         .bind(&input.data_source)
         .bind(&input.provider)
         .bind(&input.model)
         .bind(&input.server_url)
         .bind(&input.output_mode)
         .bind(input.temperature)
         .bind(input.max_tokens)
         .bind(input.thinking_budget)
         .bind(input.samples)
         .bind(&input.strategy)
         .bind(&input.pre_render_url)
         .bind(input.pre_render_timeout)
         .bind(&input.pre_render_body)
         .bind(&input.json_schema_file)
         .execute(&db_state.pool)
         .await;

         assert!(result.is_ok(), "Failed to create job: {:?}", result.err());
         let job_id = result.unwrap().last_insert_rowid();
         assert!(job_id > 0);

         // Test get job
         let job = sqlx::query_as::<_, InferenceJob>(
             r#"SELECT * FROM inference_jobs WHERE id = ?"#,
         )
         .bind(job_id)
         .fetch_optional(&db_state.pool)
         .await
         .expect("Failed to fetch job")
         .expect("Job not found");

         assert_eq!(job.name, "Test Job");
         assert_eq!(job.prompt_file, "test.jinja2");
         assert_eq!(job.status, "pending");

         // Test update job
         let update_input = InferenceJobInput {
             name: "Updated Job".to_string(),
             prompt_file: "updated.jinja2".to_string(),
             data_source: "updated_data.jsonl".to_string(),
             provider: "OpenAI".to_string(),
             model: "gpt-4".to_string(),
             server_url: "https://api.openai.com/v1".to_string(),
             output_mode: "JSON Schema".to_string(),
             temperature: Some(0.3),
             max_tokens: Some(2000),
             thinking_budget: Some(1000),
             samples: 50,
             strategy: "exhaustive".to_string(),
             pre_render_url: Some("http://updated-example.com/api".to_string()),
             pre_render_timeout: Some(60),
             pre_render_body: Some(r#"{"query": "updated"}"#.to_string()),
             json_schema_file: Some("updated_schema.json".to_string()),
         };

         let result = sqlx::query(
             r#"
             UPDATE inference_jobs SET
                 name = ?1, prompt_file = ?2, data_source = ?3, provider = ?4, model = ?5,
                 server_url = ?6, output_mode = ?7, temperature = ?8, max_tokens = ?9,
                 thinking_budget = ?10, samples = ?11, strategy = ?12, pre_render_url = ?13,
                 pre_render_timeout = ?14, pre_render_body = ?15, json_schema_file = ?16,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?17
             "#,
         )
         .bind(&update_input.name)
         .bind(&update_input.prompt_file)
         .bind(&update_input.data_source)
         .bind(&update_input.provider)
         .bind(&update_input.model)
         .bind(&update_input.server_url)
         .bind(&update_input.output_mode)
         .bind(update_input.temperature)
         .bind(update_input.max_tokens)
         .bind(update_input.thinking_budget)
         .bind(update_input.samples)
         .bind(&update_input.strategy)
         .bind(&update_input.pre_render_url)
         .bind(update_input.pre_render_timeout)
         .bind(&update_input.pre_render_body)
         .bind(&update_input.json_schema_file)
         .bind(job_id)
         .execute(&db_state.pool)
         .await;

         assert!(result.is_ok(), "Failed to update job: {:?}", result.err());

         // Verify update
         let updated_job = sqlx::query_as::<_, InferenceJob>(
             r#"SELECT * FROM inference_jobs WHERE id = ?"#,
         )
         .bind(job_id)
         .fetch_optional(&db_state.pool)
         .await
         .expect("Failed to fetch updated job")
         .expect("Updated job not found");

         assert_eq!(updated_job.name, "Updated Job");
         assert_eq!(updated_job.model, "gpt-4");
         assert_eq!(updated_job.samples, 50);

         // Test list jobs
         let jobs = sqlx::query_as::<_, InferenceJob>(
             r#"SELECT * FROM inference_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?"#,
         )
         .bind(10)
         .bind(0)
         .fetch_all(&db_state.pool)
         .await
         .expect("Failed to list jobs");

         assert_eq!(jobs.len(), 1);
         assert_eq!(jobs[0].id, job_id);

         // Test delete job
         let result = sqlx::query(r#"DELETE FROM inference_jobs WHERE id = ?"#)
             .bind(job_id)
             .execute(&db_state.pool)
             .await;

         assert!(result.is_ok());
         assert!(result.unwrap().rows_affected() > 0);

         // Verify deletion
         let job_after_delete = sqlx::query_as::<_, InferenceJob>(
             r#"SELECT * FROM inference_jobs WHERE id = ?"#,
         )
         .bind(job_id)
         .fetch_optional(&db_state.pool)
         .await
         .expect("Failed to get job after deletion");

         assert!(job_after_delete.is_none());

         // Clean up
         let _ = std::fs::remove_dir_all(&test_project_dir);
     }

     #[tokio::test]
     async fn test_collection_operations() {
         // Create a temporary directory with .nightshift folder to simulate a project
         let temp_dir = std::env::temp_dir();
         let unique_id = Uuid::new_v4().to_string();
         let test_project_dir = temp_dir.join(format!("nightshift_test_project_{}", unique_id));
         let nightshift_dir = test_project_dir.join(".nightshift");

         // Create .nightshift directory
         std::fs::create_dir_all(&nightshift_dir).expect("Failed to create .nightshift dir");

         // Initialize database (will find project root and create db in .nightshift)
         let db_state = DatabaseState::new(&test_project_dir).await.expect("Failed to initialize database");

         // Create a job first
         let input = InferenceJobInput {
             name: "Collection Test Job".to_string(),
             prompt_file: "test.jinja2".to_string(),
             data_source: "data.jsonl".to_string(),
             provider: "Local".to_string(),
             model: "test-model".to_string(),
             server_url: "http://localhost:8000".to_string(),
             output_mode: "JSON".to_string(),
             temperature: None,
             max_tokens: None,
             thinking_budget: None,
             samples: 5,
             strategy: "single".to_string(),
             pre_render_url: None,
             pre_render_timeout: None,
             pre_render_body: None,
             json_schema_file: None,
         };

         let result = sqlx::query(
             r#"
             INSERT INTO inference_jobs (
                 name, prompt_file, data_source, provider, model, server_url,
                 output_mode, temperature, max_tokens, thinking_budget, samples, strategy,
                 pre_render_url, pre_render_timeout, pre_render_body, json_schema_file, status
             )
             VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'pending'
             )
             "#,
         )
         .bind(&input.name)
         .bind(&input.prompt_file)
         .bind(&input.data_source)
         .bind(&input.provider)
         .bind(&input.model)
         .bind(&input.server_url)
         .bind(&input.output_mode)
         .bind(input.temperature)
         .bind(input.max_tokens)
         .bind(input.thinking_budget)
         .bind(input.samples)
         .bind(&input.strategy)
         .bind(&input.pre_render_url)
         .bind(input.pre_render_timeout)
         .bind(&input.pre_render_body)
         .bind(&input.json_schema_file)
         .execute(&db_state.pool)
         .await;

         assert!(result.is_ok(), "Failed to insert inference job: {:?}", result.err());
         let job_id = result.unwrap().last_insert_rowid();

         // Test create collection
         let result = sqlx::query(
             r#"INSERT INTO collections (job_id, name) VALUES (?1, ?2)"#,
         )
         .bind(job_id)
         .bind("Test Collection")
         .execute(&db_state.pool)
         .await;

         assert!(result.is_ok());
         let collection_id = result.unwrap().last_insert_rowid();
         assert!(collection_id > 0);

         // Test add collection items
         let item1 = serde_json::json!({ "id": 1, "name": "Test 1", "value": 100 });
         let item2 = serde_json::json!({ "id": 2, "name": "Test 2", "value": 200 });

         let result1 = sqlx::query(
             r#"INSERT INTO collection_items (collection_id, data) VALUES (?1, ?2)"#,
         )
         .bind(collection_id)
         .bind(item1)
         .execute(&db_state.pool)
         .await;

         let result2 = sqlx::query(
             r#"INSERT INTO collection_items (collection_id, data) VALUES (?1, ?2)"#,
         )
         .bind(collection_id)
         .bind(item2)
         .execute(&db_state.pool)
         .await;

         assert!(result1.is_ok());
         assert!(result2.is_ok());

         let item1_id = result1.unwrap().last_insert_rowid();
         let item2_id = result2.unwrap().last_insert_rowid();

         assert!(item1_id > 0);
         assert!(item2_id > 0);
         assert_ne!(item1_id, item2_id);

         // Test get collection items
         let items = sqlx::query_as::<_, CollectionItem>(
             r#"SELECT * FROM collection_items WHERE collection_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"#,
         )
         .bind(collection_id)
         .bind(10)
         .bind(0)
         .fetch_all(&db_state.pool)
         .await
         .expect("Failed to get collection items");

         assert_eq!(items.len(), 2);

         // Test collection count
         let count: i64 = sqlx::query_scalar(
             r#"SELECT COUNT(*) FROM collection_items WHERE collection_id = ?"#,
         )
         .bind(collection_id)
         .fetch_one(&db_state.pool)
         .await
         .expect("Failed to get collection count");

         assert_eq!(count, 2);

         // Clean up
         let _ = std::fs::remove_dir_all(&test_project_dir);
     }
 }
