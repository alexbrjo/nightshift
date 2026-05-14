use super::*;

pub(crate) fn method_level_config_string(method: &MethodDocument, key: &str) -> Option<String> {
    yaml_string(yaml_lookup(&method.parameters, key))
        .or_else(|| yaml_string(yaml_lookup(&method.provider, key)))
}

static JSONL_APPEND_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn append_jsonl(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!("Failed to create JSONL directory '{}': {}", parent.display(), e)
        })?;
    }
    let mut line = serde_json::to_string(value)
        .map_err(|e| format!("Failed to encode JSONL record: {}", e))?;
    line.push('\n');
    use std::io::Write;
    let _guard = JSONL_APPEND_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "JSONL append lock is poisoned".to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open JSONL file '{}': {}", path.display(), e))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to append JSONL file '{}': {}", path.display(), e))?;
    file.sync_data().map_err(|e| format!("Failed to sync JSONL file '{}': {}", path.display(), e))
}

pub(crate) fn execution_snapshot_ref(execution_id: i64) -> String {
    format!(".nightshift/executions/{}/snapshot", execution_id)
}

pub(crate) fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path '{}' has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory '{}': {}", parent.display(), e))?;
    let temp_path = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("write"),
        uuid::Uuid::new_v4()
    ));
    {
        use std::io::Write;
        let mut file =
            fs::OpenOptions::new().create_new(true).write(true).open(&temp_path).map_err(|e| {
                format!("Failed to create temp file '{}': {}", temp_path.display(), e)
            })?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write temp file '{}': {}", temp_path.display(), e))?;
        file.sync_data()
            .map_err(|e| format!("Failed to sync temp file '{}': {}", temp_path.display(), e))?;
    }
    fs::rename(&temp_path, path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to replace '{}' with '{}': {}", temp_path.display(), path.display(), e)
    })
}

pub(crate) fn encode_execution_metadata(
    execution_id: i64,
    method_id: &str,
    content_hash: &str,
    status: &str,
    error_message: Option<&str>,
    created_at: Option<&str>,
    started_at: Option<&str>,
    completed_at: Option<&str>,
) -> Result<String, String> {
    serde_yaml::to_string(&serde_json::json!({
        "id": execution_id,
        "methodId": method_id,
        "methodContentHash": content_hash,
        "status": status,
        "errorMessage": error_message,
        "createdAt": created_at,
        "startedAt": started_at,
        "completedAt": completed_at,
    }))
    .map_err(|e| format!("Failed to encode execution metadata: {}", e))
}

pub(crate) fn ensure_execution_folder(
    db: &DatabaseState,
    execution_id: i64,
    method: &MethodDocument,
    content_hash: &str,
) -> Result<(), String> {
    let root = project_root(db)?;
    let dir = execution_dir(&root, execution_id);
    fs::create_dir_all(dir.join("snapshot").join("files"))
        .map_err(|e| format!("Failed to create execution snapshot folder: {}", e))?;
    fs::create_dir_all(dir.join("outputs"))
        .map_err(|e| format!("Failed to create execution outputs folder: {}", e))?;
    fs::create_dir_all(dir.join("files"))
        .map_err(|e| format!("Failed to create execution files folder: {}", e))?;
    write_text_atomic(
        &dir.join("execution.yaml"),
        &encode_execution_metadata(
            execution_id,
            &method.id,
            content_hash,
            "queued",
            None,
            None,
            None,
            None,
        )?,
    )?;
    Ok(())
}

pub(crate) async fn rewrite_execution_metadata(
    db: &DatabaseState,
    execution_id: i64,
) -> Result<(), String> {
    let summary = sqlx::query_as::<_, MethodExecutionSummary>(
        r#"
        SELECT id, method_id, method_content_hash, status, error_message, created_at, started_at, completed_at
        FROM method_executions
        WHERE id = ?1
        "#,
    )
    .bind(execution_id)
    .fetch_one(&db.pool())
    .await
    .map_err(|e| format!("Failed to read execution metadata: {}", e))?;
    let root = project_root(db)?;
    write_text_atomic(
        &execution_dir(&root, execution_id).join("execution.yaml"),
        &encode_execution_metadata(
            summary.id,
            &summary.method_id,
            &summary.method_content_hash,
            &summary.status,
            summary.error_message.as_deref(),
            Some(&summary.created_at),
            summary.started_at.as_deref(),
            summary.completed_at.as_deref(),
        )?,
    )
}

pub(crate) async fn cleanup_failed_execution_start(
    db: &DatabaseState,
    execution_id: i64,
) -> Result<(), String> {
    if let Ok(root) = project_root(db) {
        let dir = execution_dir(&root, execution_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| {
                format!("Failed to remove incomplete execution folder '{}': {}", dir.display(), e)
            })?;
        }
    }
    sqlx::query("DELETE FROM method_executions WHERE id = ?1")
        .bind(execution_id)
        .execute(&db.pool())
        .await
        .map_err(|e| format!("Failed to remove incomplete execution row: {}", e))?;
    Ok(())
}

pub(crate) fn snapshot_method_for_execution(
    db: &DatabaseState,
    execution_id: i64,
    method: &MethodDocument,
) -> Result<MethodDocument, String> {
    let root = project_root(db)?;
    let snapshot_dir = execution_dir(&root, execution_id).join("snapshot");
    let mut frozen = method.clone();
    freeze_files(&mut frozen, &root, &snapshot_dir)?;
    write_method_document(&snapshot_dir.join("method.yaml"), &frozen)?;
    Ok(frozen)
}
