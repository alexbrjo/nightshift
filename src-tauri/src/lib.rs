use tauri::Emitter;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use walkdir::WalkDir;
use chrono::Utc;
use uuid::Uuid;

fn modified_to_string(metadata: &std::fs::Metadata) -> Option<String> {
    metadata.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;
    
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;
        let file_type = if metadata.is_dir() { "dir" } else { "file" };
        
        result.push(FileEntry {
            path: entry.path().to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            entry_type: file_type.to_string(),
            size: if metadata.is_file() { Some(metadata.len()) } else { None },
            modified_at: modified_to_string(&metadata),
        });
    }
    
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("Failed to remove directory: {}", e))
    } else {
        fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
async fn create_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
async fn get_project_tree(root_path: String, max_depth: Option<usize>) -> Result<Vec<FileEntry>, String> {
    let depth = max_depth.unwrap_or(3);
    let mut entries = Vec::new();
    
    for entry in WalkDir::new(&root_path)
        .max_depth(depth)
        .follow_links(false)
        .sort_by_file_name()
    {
        let entry = entry.map_err(|e| format!("Walk error: {}", e))?;
        let path = entry.path();
        
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') || name == "node_modules" || name == ".tauri" {
                continue;
            }
        }
        
        let metadata = entry.metadata().map_err(|e| format!("Metadata error: {}", e))?;
        entries.push(FileEntry {
            path: path.to_string_lossy().to_string(),
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
            entry_type: if metadata.is_dir() { "dir".to_string() } else { "file".to_string() },
            size: if metadata.is_file() { Some(metadata.len()) } else { None },
            modified_at: modified_to_string(&metadata),
        });
    }
    
    Ok(entries)
}

#[tauri::command]
async fn open_project(path: String, app: tauri::AppHandle) -> Result<ProjectInfo, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("Path does not exist".to_string());
    }
    
    // Create .nightshift directory for project data
    let nightshift_dir = path_buf.join(".nightshift");
    fs::create_dir_all(&nightshift_dir).ok();
    
    let now = Utc::now().to_rfc3339();
    let project = ProjectInfo {
        id: Uuid::new_v4().to_string(),
        name: path_buf.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("untitled")
            .to_string(),
        path,
        created_at: now.clone(),
        updated_at: now,
    };
    
    // Notify frontend of project open
    app.emit("project-opened", &project).map_err(|e| format!("Emit error: {}", e))?;
    
    Ok(project)
}

#[tauri::command]
async fn create_job(
    project_id: String,
    name: String,
    job_type: String,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let now = Utc::now().to_rfc3339();
    Ok(serde_json::json!({
        "id": Uuid::new_v4().to_string(),
        "project_id": project_id,
        "name": name,
        "type": job_type,
        "config": config,
        "status": "pending",
        "progress": 0,
        "total_items": 0,
        "completed_items": 0,
        "error_count": 0,
        "created_at": now.clone(),
        "updated_at": now,
    }))
}

#[tauri::command]
async fn call_llm(
    url: String,
    model: String,
    messages: Vec<serde_json::Value>,
    temperature: Option<f64>,
    max_tokens: Option<i32>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
    });
    
    if let Some(temp) = temperature {
        body["temperature"] = temp.into();
    }
    if let Some(tokens) = max_tokens {
        body["max_tokens"] = tokens.into();
    }
    
    let response = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("API error: {}", response.status()));
    }
    
    let json: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse JSON: {}", e))?;
    Ok(json)
}

#[tauri::command]
async fn execute_js(_script: String, _input_data: serde_json::Value) -> Result<serde_json::Value, String> {
    // Placeholder - requires sandboxed JS runtime (quickjs-rs) in production
    Err("JavaScript execution requires a sandboxed runtime. This is a placeholder.".to_string())
}

#[tauri::command]
async fn save_pipeline_yaml(path: String, content: String) -> Result<(), String> {
    write_file(path, content).await
}

#[tauri::command]
async fn load_pipeline_yaml(path: String) -> Result<String, String> {
    read_file(path).await
}

#[tauri::command]
async fn export_to_jsonl(items: Vec<serde_json::Value>, path: String) -> Result<(), String> {
    let mut file = fs::File::create(&path).map_err(|e| format!("Failed to create file: {}", e))?;
    for item in items {
        writeln!(file, "{}", serde_json::to_string(&item).map_err(|e| format!("JSON error: {}", e))?)
            .map_err(|e| format!("Write error: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn export_to_csv(items: Vec<serde_json::Value>, path: String) -> Result<(), String> {
    let mut writer = csv::Writer::from_path(&path).map_err(|e| format!("Failed to create CSV: {}", e))?;
    
    if items.is_empty() {
        return Ok(());
    }
    
    if let Some(first) = items.first() {
        if let Some(obj) = first.as_object() {
            let headers: Vec<&String> = obj.keys().collect();
            writer.write_record(&headers).map_err(|e| format!("CSV write error: {}", e))?;
        }
    }
    
    for item in &items {
        if let Some(obj) = item.as_object() {
            let values: Vec<String> = obj.values().map(|v| {
                match v {
                    serde_json::Value::String(s) => s.clone(),
                    _ => serde_json::to_string(v).unwrap_or_default(),
                }
            }).collect();
            writer.write_record(&values).map_err(|e| format!("CSV write error: {}", e))?;
        }
    }
    
    writer.flush().map_err(|e| format!("CSV flush error: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn create_agent_db(project_path: String, run_id: String) -> Result<String, String> {
    let db_dir = PathBuf::from(&project_path).join(".nightshift").join("agents").join(&run_id);
    fs::create_dir_all(&db_dir).map_err(|e| format!("Failed to create agent DB dir: {}", e))?;
    Ok(db_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_analysis_result(path: String, content: String) -> Result<(), String> {
    write_file(path, content).await
}

#[tauri::command]
async fn get_app_data_dir() -> Result<String, String> {
    dirs::data_local_dir()
        .map(|d| d.join("nightshift").to_string_lossy().to_string())
        .ok_or_else(|| "Failed to determine app data directory".to_string())
}

#[tauri::command]
async fn file_exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(&path).exists())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            list_directory,
            read_file,
            write_file,
            delete_file,
            create_directory,
            get_project_tree,
            open_project,
            create_job,
            call_llm,
            execute_js,
            save_pipeline_yaml,
            load_pipeline_yaml,
            export_to_jsonl,
            export_to_csv,
            create_agent_db,
            save_analysis_result,
            get_app_data_dir,
            file_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
