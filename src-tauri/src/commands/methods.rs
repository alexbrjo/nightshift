use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use url::Url;
use uuid::Uuid;

use crate::database::DatabaseState;
use crate::job_executor::{JobEvent, JobExecutor, WorkerConfig};
use crate::state::{MethodExecutionControl, MethodExecutionManager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MethodManifest {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<MethodFileRef>,
    #[serde(default)]
    pub workflow: MethodWorkflow,
    #[serde(default, skip_serializing_if = "serde_yaml::Value::is_null")]
    pub parameters: serde_yaml::Value,
    #[serde(default, skip_serializing_if = "serde_yaml::Value::is_null")]
    pub provider: serde_yaml::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MethodFileRef {
    pub id: String,
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct MethodWorkflow {
    #[serde(default)]
    pub nodes: Vec<MethodWorkflowNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MethodWorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "serde_yaml::Value::is_null")]
    pub config: serde_yaml::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMethodInput {
    pub method: MethodManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMethodAgentInput {
    pub message: String,
    pub current_method: Option<MethodManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMethodAgentOutput {
    pub message: String,
    pub method: Option<MethodManifest>,
    #[serde(default)]
    pub questions: Vec<String>,
}

#[derive(Debug, Serialize)]
struct AgentLlmRequest {
    model: String,
    messages: Vec<AgentLlmMessage>,
    temperature: f64,
    max_tokens: i32,
    response_format: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct AgentLlmMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct AgentLlmResponse {
    choices: Vec<AgentLlmChoice>,
}

#[derive(Debug, Deserialize)]
struct AgentLlmChoice {
    message: AgentLlmResponseMessage,
}

#[derive(Debug, Deserialize)]
struct AgentLlmResponseMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

impl AgentLlmResponseMessage {
    fn content(&self) -> &str {
        let content = self.content.as_deref().unwrap_or("");
        if !content.trim().is_empty() {
            return content;
        }
        self.reasoning_content.as_deref().unwrap_or("")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodPreflightBlocker {
    pub code: String,
    pub message: String,
    pub file_id: Option<String>,
    pub file_kind: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodPreflightResult {
    pub status: String,
    pub blockers: Vec<MethodPreflightBlocker>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodSummary {
    pub id: String,
    pub title: String,
    pub content_hash: String,
    pub folder_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodExecutionSummary {
    pub id: i64,
    pub method_id: String,
    pub method_content_hash: String,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodExecutionNodeSummary {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: String,
    pub node_type: String,
    pub status: String,
    pub output_ref: Option<String>,
    pub error_message: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodExecutionEventSummary {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: Option<String>,
    pub event_type: String,
    pub payload_json: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodArtifactSummary {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: Option<String>,
    pub artifact_type: String,
    pub storage_kind: String,
    pub storage_ref: String,
    pub content_hash: String,
    pub created_at: String,
}

const SECRET_KEYS: &[&str] =
    &["api_key", "apikey", "password", "secret", "access_token", "refresh_token", "bearer_token"];

fn project_root(db: &DatabaseState) -> Result<PathBuf, String> {
    let root = db.get_project_root();
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("No project folder is open".into());
    }
    Ok(root)
}

fn methods_dir(project_root: &Path) -> PathBuf {
    project_root.join("methods")
}

fn method_dir(project_root: &Path, id: &str) -> PathBuf {
    methods_dir(project_root).join(id)
}

fn chat_endpoint(base_url: &str) -> Result<String, String> {
    Url::parse(base_url).map_err(|e| format!("Invalid chat agent server URL: {}", e))?;
    Ok(if base_url.ends_with("/v1") {
        format!("{}/chat/completions", base_url)
    } else if base_url.ends_with('/') {
        format!("{}v1/chat/completions", base_url)
    } else {
        format!("{}/v1/chat/completions", base_url)
    })
}

fn project_file_inventory(project_root: &Path) -> Result<Vec<String>, String> {
    fn walk(dir: &Path, root: &Path, files: &mut Vec<String>) -> Result<(), String> {
        let Some(name) = dir.file_name().and_then(|name| name.to_str()) else {
            return Ok(());
        };
        if matches!(name, ".git" | ".nightshift" | "methods" | "node_modules" | "target" | "dist") {
            return Ok(());
        }
        for entry in
            fs::read_dir(dir).map_err(|e| format!("Failed to read project files: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read project file entry: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, files)?;
            } else if path.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| format!("Failed to list project file: {}", e))?
                    .to_string_lossy()
                    .replace('\\', "/");
                files.push(rel);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    walk(project_root, project_root, &mut files)?;
    files.sort();
    files.truncate(400);
    Ok(files)
}

fn chat_agent_schema() -> serde_json::Value {
    serde_json::from_str(
        r#"{
          "type": "json_schema",
          "json_schema": {
            "name": "method_agent_response",
            "strict": false,
            "schema": {
              "type": "object",
              "additionalProperties": false,
              "required": ["message", "method", "questions"],
              "properties": {
                "message": { "type": "string" },
                "questions": { "type": "array", "items": { "type": "string" } },
                "method": {
                  "anyOf": [
                    { "type": "null" },
                    {
                      "type": "object",
                      "required": ["schema_version", "id", "title", "workflow"],
                      "additionalProperties": true,
                      "properties": {
                        "schema_version": { "type": "integer" },
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "objective": { "type": "string" },
                        "files": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "required": ["id", "kind", "path"],
                            "additionalProperties": false,
                            "properties": {
                              "id": { "type": "string" },
                              "kind": { "type": "string" },
                              "path": { "type": "string" }
                            }
                          }
                        },
                        "provider": { "type": "object" },
                        "parameters": { "type": "object" },
                        "workflow": {
                          "type": "object",
                          "required": ["nodes"],
                          "additionalProperties": false,
                          "properties": {
                            "nodes": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "required": ["id", "type", "depends_on"],
                                "additionalProperties": true,
                                "properties": {
                                  "id": { "type": "string" },
                                  "type": { "type": "string" },
                                  "depends_on": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                  },
                                  "config": { "type": "object" }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        }"#,
    )
    .expect("method agent schema is valid JSON")
}

fn extract_json_response(content: &str) -> Result<ChatMethodAgentOutput, String> {
    let trimmed = content.trim();
    let json_text = if let Some(stripped) = trimmed.strip_prefix("```json") {
        stripped.trim().trim_end_matches("```").trim()
    } else if let Some(stripped) = trimmed.strip_prefix("```") {
        stripped.trim().trim_end_matches("```").trim()
    } else {
        trimmed
    };
    serde_json::from_str(json_text).map_err(|e| {
        format!("Method agent returned invalid JSON: {}. Raw response: {}", e, content)
    })
}

fn require_nonempty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{} must not be empty", label))
    } else {
        Ok(())
    }
}

fn validate_method_id(id: &str) -> Result<(), String> {
    require_nonempty("method.id", id)?;
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("method.id must not contain path separators or '..'".into());
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_absolute() || path.contains("..") {
        return Err(format!("Method file path must be project-relative: {}", path));
    }
    if path.starts_with(".nightshift/") || path.starts_with("methods/") {
        return Err(format!("Method file path cannot point inside app-managed storage: {}", path));
    }
    Ok(())
}

fn reject_secret_values(value: &serde_yaml::Value, path: &str) -> Result<(), String> {
    match value {
        serde_yaml::Value::Mapping(map) => {
            for (key, child) in map {
                let key_text = key.as_str().unwrap_or("").to_lowercase();
                let child_path = if path.is_empty() {
                    key_text.clone()
                } else {
                    format!("{}.{}", path, key_text)
                };
                if SECRET_KEYS.contains(&key_text.as_str()) && !key_text.ends_with("_ref") {
                    match child {
                        serde_yaml::Value::Null => {}
                        serde_yaml::Value::String(s) if s.trim().is_empty() => {}
                        _ => {
                            return Err(format!(
                                "Method contains a secret-like value at '{}'; store secrets in global settings and reference them by id",
                                child_path
                            ));
                        }
                    }
                }
                reject_secret_values(child, &child_path)?;
            }
        }
        serde_yaml::Value::Sequence(items) => {
            for (index, child) in items.iter().enumerate() {
                reject_secret_values(child, &format!("{}[{}]", path, index))?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn validate_method(method: &MethodManifest) -> Result<(), String> {
    if method.schema_version != 1 {
        return Err("method.schema_version must be 1".into());
    }
    validate_method_id(&method.id)?;
    require_nonempty("method.title", &method.title)?;

    let manifest_value =
        serde_yaml::to_value(method).map_err(|e| format!("Failed to inspect method: {}", e))?;
    reject_secret_values(&manifest_value, "")?;

    let mut file_ids = HashSet::new();
    for file in &method.files {
        require_nonempty("method.files[].id", &file.id)?;
        require_nonempty("method.files[].kind", &file.kind)?;
        require_nonempty("method.files[].path", &file.path)?;
        if !file_ids.insert(file.id.as_str()) {
            return Err(format!("method.files id '{}' is duplicated", file.id));
        }
        if !file.path.starts_with("files/") {
            validate_relative_path(&file.path)?;
        }
    }

    if method.workflow.nodes.is_empty() {
        return Err("method.workflow.nodes must contain at least one node".into());
    }
    let mut node_ids = HashSet::new();
    for node in &method.workflow.nodes {
        require_nonempty("method.workflow.nodes[].id", &node.id)?;
        require_nonempty("method.workflow.nodes[].type", &node.node_type)?;
        if !node_ids.insert(node.id.as_str()) {
            return Err(format!("method.workflow node id '{}' is duplicated", node.id));
        }
    }
    for node in &method.workflow.nodes {
        for dep in &node.depends_on {
            if !node_ids.contains(dep.as_str()) {
                return Err(format!(
                    "method.workflow node '{}' depends on unknown node '{}'",
                    node.id, dep
                ));
            }
        }
    }
    detect_cycles(&method.workflow.nodes)?;
    Ok(())
}

fn required_file_kind_for_node(
    method: &MethodManifest,
    node: &MethodWorkflowNode,
) -> Vec<(&'static str, String)> {
    match node.node_type.as_str() {
        "inference" => {
            let mut kinds = vec![
                ("prompt", "Inference needs a prompt template".to_string()),
                ("data", "Inference needs a data source".to_string()),
            ];
            if config_string(node, method, "output_mode", Some("Unstructured")).as_deref()
                == Some("JSON Schema")
            {
                kinds.push(("schema", "Structured inference needs a JSON schema".to_string()));
            }
            kinds
        }
        "transform" | "eval" => {
            let mut kinds = vec![("script", "Transform/eval needs a script file".to_string())];
            if node.depends_on.is_empty() {
                kinds.push(("data", "Standalone transform needs a data source".to_string()));
            }
            kinds
        }
        _ => vec![],
    }
}

fn preflight_method_for_root(
    method: &MethodManifest,
    project_root: &Path,
) -> MethodPreflightResult {
    let mut blockers = Vec::new();
    if let Err(error) = validate_method(method) {
        blockers.push(MethodPreflightBlocker {
            code: "invalid_method".into(),
            message: error,
            file_id: None,
            file_kind: None,
            path: None,
        });
    }

    let mut seen_required = HashSet::new();
    for node in &method.workflow.nodes {
        for (kind, message) in required_file_kind_for_node(method, node) {
            if !seen_required.insert(kind) {
                continue;
            }
            if method_file_by_kind(method, kind).is_none() {
                blockers.push(MethodPreflightBlocker {
                    code: "missing_file".into(),
                    message,
                    file_id: None,
                    file_kind: Some(kind.into()),
                    path: None,
                });
            }
        }
    }

    for file in &method.files {
        if file.path.starts_with("files/") {
            continue;
        }
        if let Err(error) = validate_relative_path(&file.path) {
            blockers.push(MethodPreflightBlocker {
                code: "invalid_file_path".into(),
                message: error,
                file_id: Some(file.id.clone()),
                file_kind: Some(file.kind.clone()),
                path: Some(file.path.clone()),
            });
            continue;
        }
        if !project_root.join(&file.path).is_file() {
            blockers.push(MethodPreflightBlocker {
                code: "missing_file".into(),
                message: format!("I couldn't find {} file '{}'.", file.kind, file.path),
                file_id: Some(file.id.clone()),
                file_kind: Some(file.kind.clone()),
                path: Some(file.path.clone()),
            });
        }
    }

    let has_inference = method.workflow.nodes.iter().any(|node| node.node_type == "inference");
    if has_inference {
        let model = yaml_string(yaml_lookup(&method.provider, "model"))
            .or_else(|| yaml_string(yaml_lookup(&method.parameters, "model")));
        if model.as_deref().unwrap_or("").trim().is_empty() {
            blockers.push(MethodPreflightBlocker {
                code: "missing_model".into(),
                message: "Inference needs a model name.".into(),
                file_id: None,
                file_kind: None,
                path: None,
            });
        }
    }

    MethodPreflightResult {
        status: if blockers.is_empty() { "ready" } else { "drafting" }.into(),
        blockers,
    }
}

fn format_preflight_blockers(result: &MethodPreflightResult) -> String {
    result.blockers.iter().map(|blocker| blocker.message.as_str()).collect::<Vec<_>>().join(" ")
}

fn detect_cycles(nodes: &[MethodWorkflowNode]) -> Result<(), String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Unseen,
        InProgress,
        Done,
    }

    fn visit<'a>(
        id: &'a str,
        marks: &mut HashMap<&'a str, Mark>,
        nodes_by_id: &HashMap<&'a str, &'a MethodWorkflowNode>,
    ) -> Result<(), String> {
        match marks.get(id).copied().unwrap_or(Mark::Unseen) {
            Mark::Done => return Ok(()),
            Mark::InProgress => {
                return Err(format!("method.workflow has a cycle through '{}'", id))
            }
            Mark::Unseen => {}
        }
        marks.insert(id, Mark::InProgress);
        if let Some(node) = nodes_by_id.get(id) {
            for dep in &node.depends_on {
                visit(dep, marks, nodes_by_id)?;
            }
        }
        marks.insert(id, Mark::Done);
        Ok(())
    }

    let mut marks: HashMap<&str, Mark> =
        nodes.iter().map(|n| (n.id.as_str(), Mark::Unseen)).collect();
    let nodes_by_id: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    for node in nodes {
        visit(&node.id, &mut marks, &nodes_by_id)?;
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn frozen_file_path(source_path: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let ext = Path::new(source_path).extension().and_then(|e| e.to_str()).unwrap_or("bin");
    format!("files/{}.{}", hex(&digest), ext)
}

fn freeze_files(
    method: &mut MethodManifest,
    project_root: &Path,
    dest: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dest.join("files"))
        .map_err(|e| format!("Failed to create method files directory: {}", e))?;
    for file in &mut method.files {
        if file.path.starts_with("files/") {
            continue;
        }
        validate_relative_path(&file.path)?;
        let source = project_root.join(&file.path);
        let bytes = fs::read(&source)
            .map_err(|e| format!("Failed to read method file '{}': {}", file.path, e))?;
        let frozen_path = frozen_file_path(&file.path, &bytes);
        let target = dest.join(&frozen_path);
        if !target.exists() {
            fs::write(&target, bytes)
                .map_err(|e| format!("Failed to freeze method file '{}': {}", file.path, e))?;
        }
        file.path = frozen_path;
    }
    Ok(())
}

fn hash_directory(folder: &Path) -> Result<String, String> {
    let mut paths = Vec::new();
    fn collect(dir: &Path, root: &Path, paths: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in
            fs::read_dir(dir).map_err(|e| format!("Failed to read method folder: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read method folder entry: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                collect(&path, root, paths)?;
            } else {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| format!("Failed to hash method folder: {}", e))?
                    .to_path_buf();
                paths.push(rel);
            }
        }
        Ok(())
    }
    collect(folder, folder, &mut paths)?;
    paths.sort();

    let mut hasher = Sha256::new();
    for rel in paths {
        let rel_text = rel.to_string_lossy();
        hasher.update(rel_text.as_bytes());
        hasher.update([0]);
        let bytes = fs::read(folder.join(&rel))
            .map_err(|e| format!("Failed to hash method file '{}': {}", rel_text, e))?;
        hasher.update(bytes);
        hasher.update([0]);
    }
    Ok(hex(&hasher.finalize()))
}

fn read_manifest(folder: &Path) -> Result<MethodManifest, String> {
    let text = fs::read_to_string(folder.join("method.yaml"))
        .map_err(|e| format!("Failed to read method.yaml: {}", e))?;
    serde_yaml::from_str(&text).map_err(|e| format!("Failed to parse method.yaml: {}", e))
}

async fn upsert_method_metadata(
    db: &DatabaseState,
    method: &MethodManifest,
    content_hash: &str,
    folder_path: &Path,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO methods (id, title, content_hash, folder_path)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            content_hash = excluded.content_hash,
            folder_path = excluded.folder_path
        "#,
    )
    .bind(&method.id)
    .bind(&method.title)
    .bind(content_hash)
    .bind(folder_path.to_string_lossy().to_string())
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to store method metadata: {}", e))?;
    Ok(())
}

async fn save_method_to_project(
    db: &DatabaseState,
    root: &Path,
    method_input: MethodManifest,
) -> Result<MethodSummary, String> {
    validate_method(&method_input)?;
    for file in &method_input.files {
        if file.path.starts_with("files/") {
            return Err(format!(
                "Method file '{}' must reference a project file before save",
                file.id
            ));
        }
    }
    let preflight = preflight_method_for_root(&method_input, root);
    if preflight.status != "ready" {
        return Err(format!(
            "Method is not ready to save. {}",
            format_preflight_blockers(&preflight)
        ));
    }
    let final_dir = method_dir(root, &method_input.id);
    if final_dir.exists() {
        return Err(format!(
            "Method '{}' already exists; create a new method id for revisions",
            method_input.id
        ));
    }

    fs::create_dir_all(methods_dir(&root))
        .map_err(|e| format!("Failed to create methods directory: {}", e))?;
    let temp_dir = methods_dir(&root).join(format!(".{}.tmp", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp method: {}", e))?;

    let mut method = method_input;
    if let Err(e) = freeze_files(&mut method, &root, &temp_dir).and_then(|_| {
        let yaml = serde_yaml::to_string(&method)
            .map_err(|e| format!("Failed to serialize method: {}", e))?;
        fs::write(temp_dir.join("method.yaml"), yaml)
            .map_err(|e| format!("Failed to write method.yaml: {}", e))
    }) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    let content_hash = match hash_directory(&temp_dir) {
        Ok(hash) => hash,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(e);
        }
    };

    if let Err(e) = fs::rename(&temp_dir, &final_dir) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("Failed to finalize method folder: {}", e));
    }

    upsert_method_metadata(db, &method, &content_hash, &final_dir).await?;
    get_method_summary(db, &method.id).await
}

async fn get_method_summary(db: &DatabaseState, id: &str) -> Result<MethodSummary, String> {
    sqlx::query_as::<_, MethodSummary>(
        r#"
        SELECT id, title, content_hash, folder_path, created_at
        FROM methods
        WHERE id = ?1
        "#,
    )
    .bind(id)
    .fetch_one(&db.pool())
    .await
    .map_err(|e| format!("Failed to read method metadata: {}", e))
}

#[tauri::command]
pub async fn save_method(
    db: State<'_, DatabaseState>,
    input: SaveMethodInput,
) -> Result<MethodSummary, String> {
    let root = project_root(&db)?;
    save_method_to_project(&db, &root, input.method).await
}

#[tauri::command]
pub async fn chat_method_agent(
    db: State<'_, DatabaseState>,
    input: ChatMethodAgentInput,
) -> Result<ChatMethodAgentOutput, String> {
    require_nonempty("message", &input.message)?;
    let root = project_root(&db)?;
    let inventory = project_file_inventory(&root)?;
    let current_method = input.current_method.clone().unwrap_or(MethodManifest {
        schema_version: 1,
        id: "new-method".into(),
        title: "New Method".into(),
        objective: None,
        files: vec![],
        workflow: MethodWorkflow {
            nodes: vec![MethodWorkflowNode {
                id: "generate".into(),
                node_type: "inference".into(),
                depends_on: vec![],
                config: serde_yaml::Value::Null,
            }],
        },
        parameters: serde_yaml::Value::Null,
        provider: serde_yaml::from_str(
            r#"
provider: Local
server_url: http://localhost:1234
model: local-model
"#,
        )
        .map_err(|e| format!("Failed to initialize chat agent defaults: {}", e))?,
    });
    let provider = yaml_string(yaml_lookup(&current_method.provider, "provider"))
        .unwrap_or_else(|| "Local".into());
    if !matches!(provider.to_lowercase().as_str(), "local" | "openai" | "custom" | "google" | "") {
        return Err(format!(
            "Method chat agent provider '{}' is not supported yet. Use Local/OpenAI/Custom/Google with an OpenAI-compatible chat endpoint.",
            provider
        ));
    }
    let server_url = yaml_string(yaml_lookup(&current_method.provider, "server_url"))
        .unwrap_or_else(|| "http://localhost:1234".into());
    let model = yaml_string(yaml_lookup(&current_method.provider, "model"))
        .unwrap_or_else(|| "local-model".into());
    let endpoint = chat_endpoint(&server_url)?;

    let current_method_json = serde_json::to_value(&current_method)
        .map_err(|e| format!("Failed to encode draft: {}", e))?;
    let prompt = serde_json::json!({
        "user_message": input.message,
        "current_method": current_method_json,
        "project_files": inventory,
        "rules": [
            "Return only JSON matching the schema.",
            "Design or update a Nightshift Method, not a generic benchmark description.",
            "Use only project_files for method.files. Do not invent fallback paths.",
            "If a required prompt, data, schema, or script file is missing or ambiguous, put a question in questions and leave method as the best draft.",
            "Use one workflow for generate -> optional transform score -> aggregate -> analysis when appropriate.",
            "For inference sweeps, set parameters.model_values and provider.model to the first model.",
            "Do not include API keys, secrets, or passwords."
        ]
    });
    let request = AgentLlmRequest {
        model,
        messages: vec![
            AgentLlmMessage {
                role: "system".into(),
                content: "You are Nightshift's Method design agent. You convert chat into reproducible Method definitions for executing inference, transform/eval, aggregation, and analysis workflows. You ask concise questions when files or configuration are missing.".into(),
            },
            AgentLlmMessage { role: "user".into(), content: prompt.to_string() },
        ],
        temperature: 0.1,
        max_tokens: 4000,
        response_format: chat_agent_schema(),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to create method chat HTTP client: {}", e))?;
    let response = client
        .post(endpoint)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Method chat agent request failed: {}", e))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Method chat agent returned {}: {}", status, body));
    }
    let response_text =
        response.text().await.map_err(|e| format!("Failed to read method chat response: {}", e))?;
    let llm_response: AgentLlmResponse = serde_json::from_str(&response_text).map_err(|e| {
        format!("Failed to parse method chat response: {}. Raw response: {}", e, response_text)
    })?;
    let content = llm_response
        .choices
        .first()
        .map(|choice| choice.message.content())
        .ok_or_else(|| "Method chat agent returned no choices".to_string())?;
    let output = extract_json_response(content)?;
    if let Some(method) = &output.method {
        validate_method(method)?;
    }
    Ok(output)
}

#[tauri::command]
pub async fn preflight_method(
    db: State<'_, DatabaseState>,
    input: SaveMethodInput,
) -> Result<MethodPreflightResult, String> {
    let root = project_root(&db)?;
    Ok(preflight_method_for_root(&input.method, &root))
}

#[tauri::command]
pub async fn list_methods(db: State<'_, DatabaseState>) -> Result<Vec<MethodSummary>, String> {
    let methods = sqlx::query_as::<_, MethodSummary>(
        r#"
        SELECT id, title, content_hash, folder_path, created_at
        FROM methods
        ORDER BY created_at DESC, id ASC
        "#,
    )
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list methods: {}", e))?;
    Ok(methods)
}

#[tauri::command]
pub async fn get_method(
    db: State<'_, DatabaseState>,
    id: String,
) -> Result<MethodManifest, String> {
    validate_method_id(&id)?;
    let root = project_root(&db)?;
    let manifest = read_manifest(&method_dir(&root, &id))?;
    validate_method(&manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub async fn read_method_file(
    db: State<'_, DatabaseState>,
    id: String,
    path: String,
) -> Result<String, String> {
    validate_method_id(&id)?;
    if !path.starts_with("files/") || path.contains("..") {
        return Err("path must be a frozen method file path under files/".into());
    }
    let root = project_root(&db)?;
    fs::read_to_string(method_dir(&root, &id).join(path))
        .map_err(|e| format!("Failed to read method file: {}", e))
}

async fn insert_execution(
    db: &DatabaseState,
    method: &MethodManifest,
    content_hash: &str,
) -> Result<i64, String> {
    let result = sqlx::query(
        r#"
        INSERT INTO method_executions (method_id, method_content_hash, status)
        VALUES (?1, ?2, 'queued')
        "#,
    )
    .bind(&method.id)
    .bind(content_hash)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create method execution: {}", e))?;

    let execution_id = result.last_insert_rowid();
    for node in &method.workflow.nodes {
        sqlx::query(
            r#"
            INSERT INTO method_execution_nodes (execution_id, node_id, node_type, status)
            VALUES (?1, ?2, ?3, 'queued')
            "#,
        )
        .bind(execution_id)
        .bind(&node.id)
        .bind(&node.node_type)
        .execute(&db.pool())
        .await
        .map_err(|e| format!("Failed to create method execution node: {}", e))?;
    }
    Ok(execution_id)
}

async fn update_execution_status(
    db: &DatabaseState,
    execution_id: i64,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let completed =
        matches!(status, "completed" | "completed_with_errors" | "failed" | "cancelled");
    sqlx::query(
        r#"
        UPDATE method_executions
        SET status = ?1,
            error_message = ?2,
            started_at = COALESCE(started_at, CASE WHEN ?1 = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END),
            completed_at = CASE WHEN ?3 THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE id = ?4
        "#,
    )
    .bind(status)
    .bind(error)
    .bind(completed)
    .bind(execution_id)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to update method execution: {}", e))?;
    Ok(())
}

async fn update_node_status(
    db: &DatabaseState,
    execution_id: i64,
    node_id: &str,
    status: &str,
    output_ref: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let completed = matches!(status, "completed" | "failed" | "cancelled" | "not_implemented");
    sqlx::query(
        r#"
        UPDATE method_execution_nodes
        SET status = ?1,
            output_ref = COALESCE(?2, output_ref),
            error_message = ?3,
            started_at = COALESCE(started_at, CASE WHEN ?1 = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END),
            completed_at = CASE WHEN ?4 THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE execution_id = ?5 AND node_id = ?6
        "#,
    )
    .bind(status)
    .bind(output_ref)
    .bind(error)
    .bind(completed)
    .bind(execution_id)
    .bind(node_id)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to update method execution node: {}", e))?;
    Ok(())
}

async fn insert_event(
    app: &AppHandle,
    db: &DatabaseState,
    execution_id: i64,
    node_id: Option<&str>,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO method_execution_events (execution_id, node_id, event_type, payload_json)
        VALUES (?1, ?2, ?3, ?4)
        "#,
    )
    .bind(execution_id)
    .bind(node_id)
    .bind(event_type)
    .bind(&payload)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to record method execution event: {}", e))?;

    let _ = app.emit(
        "method-execution-event",
        serde_json::json!({
            "executionId": execution_id,
            "nodeId": node_id,
            "eventType": event_type,
            "payload": payload,
        }),
    );
    Ok(())
}

async fn insert_artifact(
    db: &DatabaseState,
    execution_id: i64,
    node_id: Option<&str>,
    artifact_type: &str,
    storage_kind: &str,
    storage_ref: &str,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(storage_kind.as_bytes());
    hasher.update([0]);
    hasher.update(storage_ref.as_bytes());
    let hash = hex(&hasher.finalize());

    sqlx::query(
        r#"
        INSERT INTO method_artifacts (
            execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
    )
    .bind(execution_id)
    .bind(node_id)
    .bind(artifact_type)
    .bind(storage_kind)
    .bind(storage_ref)
    .bind(&hash)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to record method artifact: {}", e))?;

    Ok(format!("{}:{}", storage_kind, storage_ref))
}

async fn read_method_artifact_from_db(
    db: &DatabaseState,
    artifact_id: i64,
) -> Result<String, String> {
    let artifact = sqlx::query_as::<_, MethodArtifactSummary>(
        r#"
        SELECT id, execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash, created_at
        FROM method_artifacts
        WHERE id = ?1
        "#,
    )
    .bind(artifact_id)
    .fetch_optional(&db.pool())
    .await
    .map_err(|e| format!("Failed to read method artifact: {}", e))?
    .ok_or_else(|| "Method artifact not found".to_string())?;

    match artifact.storage_kind.as_str() {
        "inline_json" | "inline_markdown" => Ok(artifact.storage_ref),
        "inference_job" => Ok(format!("Inference job {}", artifact.storage_ref)),
        "job_set" => Ok(format!("Inference jobs {}", artifact.storage_ref)),
        other => Err(format!("Unsupported method artifact storage kind: {}", other)),
    }
}

fn topological_nodes(nodes: &[MethodWorkflowNode]) -> Result<Vec<MethodWorkflowNode>, String> {
    let mut remaining: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut done = HashSet::new();
    let mut ordered = Vec::new();

    while !remaining.is_empty() {
        let ready_id = remaining
            .values()
            .find(|node| node.depends_on.iter().all(|dep| done.contains(dep.as_str())))
            .map(|node| node.id.clone());
        let Some(id) = ready_id else {
            return Err("method.workflow could not be ordered".into());
        };
        let node = remaining.remove(id.as_str()).expect("ready node exists");
        done.insert(node.id.as_str());
        ordered.push(node.clone());
    }
    Ok(ordered)
}

fn yaml_lookup<'a>(value: &'a serde_yaml::Value, key: &str) -> Option<&'a serde_yaml::Value> {
    value.as_mapping()?.get(serde_yaml::Value::String(key.to_string()))
}

fn yaml_string(value: Option<&serde_yaml::Value>) -> Option<String> {
    match value? {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn yaml_i32(value: Option<&serde_yaml::Value>) -> Option<i32> {
    match value? {
        serde_yaml::Value::Number(n) => n.as_i64().and_then(|v| i32::try_from(v).ok()),
        serde_yaml::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn yaml_f64(value: Option<&serde_yaml::Value>) -> Option<f64> {
    match value? {
        serde_yaml::Value::Number(n) => n.as_f64(),
        serde_yaml::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn config_string(
    node: &MethodWorkflowNode,
    method: &MethodManifest,
    key: &str,
    default: Option<&str>,
) -> Option<String> {
    yaml_string(yaml_lookup(&node.config, key))
        .or_else(|| yaml_string(yaml_lookup(&method.parameters, key)))
        .or_else(|| yaml_string(yaml_lookup(&method.provider, key)))
        .or_else(|| default.map(ToOwned::to_owned))
}

fn config_i32(
    node: &MethodWorkflowNode,
    method: &MethodManifest,
    key: &str,
    default: Option<i32>,
) -> Option<i32> {
    yaml_i32(yaml_lookup(&node.config, key))
        .or_else(|| yaml_i32(yaml_lookup(&method.parameters, key)))
        .or(default)
}

fn config_f64(node: &MethodWorkflowNode, method: &MethodManifest, key: &str) -> Option<f64> {
    yaml_f64(yaml_lookup(&node.config, key))
        .or_else(|| yaml_f64(yaml_lookup(&method.parameters, key)))
}

fn method_file_by_kind<'a>(method: &'a MethodManifest, kind: &str) -> Option<&'a MethodFileRef> {
    method.files.iter().find(|file| file.kind == kind)
}

fn resolve_configured_file(
    method: &MethodManifest,
    method_id: &str,
    configured: Option<String>,
    fallback_kind: &str,
) -> Result<String, String> {
    let file = configured
        .as_deref()
        .and_then(|id| method.files.iter().find(|file| file.id == id || file.path == id))
        .or_else(|| method_file_by_kind(method, fallback_kind))
        .ok_or_else(|| format!("No method file with kind '{}' is available", fallback_kind))?;
    if !file.path.starts_with("files/") {
        return Err(format!("Method file '{}' was not frozen", file.id));
    }
    Ok(format!("methods/{}/{}", method_id, file.path))
}

async fn create_inference_job_for_node(
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
    model_override: Option<&str>,
    name_suffix: Option<&str>,
) -> Result<i64, String> {
    let prompt_file = resolve_configured_file(
        method,
        &method.id,
        config_string(node, method, "prompt_file", None),
        "prompt",
    )?;
    let data_source = resolve_configured_file(
        method,
        &method.id,
        config_string(node, method, "data_source", None),
        "data",
    )?;
    let json_schema_file = if config_string(node, method, "output_mode", Some("Unstructured"))
        .as_deref()
        == Some("JSON Schema")
    {
        Some(resolve_configured_file(
            method,
            &method.id,
            config_string(node, method, "json_schema_file", None),
            "schema",
        )?)
    } else {
        None
    };
    let name = format!(
        "method-{}-{}-{}{}",
        method.id,
        execution_id,
        node.id,
        name_suffix.map(|suffix| format!("-{}", suffix)).unwrap_or_default()
    );
    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, temperature, max_tokens, thinking_budget, samples, strategy,
            json_schema_file, status
        )
        VALUES (
            'inference', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(prompt_file)
    .bind(data_source)
    .bind(config_string(node, method, "provider", Some("Local")).unwrap_or_else(|| "Local".into()))
    .bind(
        model_override
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| config_string(node, method, "model", Some("")).unwrap_or_default()),
    )
    .bind(config_string(node, method, "server_url", Some("")).unwrap_or_default())
    .bind(config_string(node, method, "output_mode", Some("Unstructured")).unwrap())
    .bind(config_f64(node, method, "temperature"))
    .bind(config_i32(node, method, "max_tokens", None))
    .bind(config_i32(node, method, "thinking_budget", None))
    .bind(config_i32(node, method, "samples", Some(1)).unwrap_or(1))
    .bind(config_string(node, method, "strategy", Some("single")).unwrap())
    .bind(json_schema_file)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create inference job for method node '{}': {}", node.id, e))?;
    Ok(result.last_insert_rowid())
}

async fn create_transform_job_for_node(
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
    data_source_override: Option<String>,
    name_suffix: Option<&str>,
) -> Result<i64, String> {
    let data_source = match data_source_override {
        Some(source) => source,
        None => resolve_configured_file(
            method,
            &method.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let script_file = resolve_configured_file(
        method,
        &method.id,
        config_string(node, method, "script_file", None),
        "script",
    )?;
    let name = format!(
        "method-{}-{}-{}{}",
        method.id,
        execution_id,
        node.id,
        name_suffix.map(|suffix| format!("-{}", suffix)).unwrap_or_default()
    );
    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, transform_script_file, transform_error_mode,
            transform_output_mode, status
        )
        VALUES (
            'transform', ?1, '', ?2, 'Nightshift', 'JavaScript', '', 'Transform',
            1, 'exhaustive', ?3, ?4, ?5, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(data_source)
    .bind(script_file)
    .bind(config_string(node, method, "error_mode", Some("stop")).unwrap())
    .bind(config_string(node, method, "output_mode", Some("one_to_one")).unwrap())
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create transform job for method node '{}': {}", node.id, e))?;
    Ok(result.last_insert_rowid())
}

async fn collection_ref_for_job(db: &DatabaseState, job_id: i64) -> Result<String, String> {
    let collection_id: i64 = sqlx::query_scalar("SELECT id FROM collections WHERE job_id = ?1")
        .bind(job_id)
        .fetch_one(&db.pool())
        .await
        .map_err(|e| format!("Failed to find output collection for job {}: {}", job_id, e))?;
    Ok(format!("collection:{}", collection_id))
}

fn parse_job_ids(output_ref: &str) -> Result<Vec<i64>, String> {
    if let Some(job_id) = output_ref.strip_prefix("inference_job:") {
        return job_id
            .parse::<i64>()
            .map(|id| vec![id])
            .map_err(|_| format!("Invalid job ref '{}'", output_ref));
    }
    if let Some(ids) = output_ref.strip_prefix("job_set:") {
        return ids
            .split(',')
            .filter(|id| !id.trim().is_empty())
            .map(|id| {
                id.parse::<i64>().map_err(|_| format!("Invalid job set ref '{}'", output_ref))
            })
            .collect();
    }
    Ok(vec![])
}

async fn upstream_collection_source(
    db: &DatabaseState,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(dep) = node.depends_on.first() else {
        return Ok(None);
    };
    let Some(output_ref) = node_outputs.get(dep) else {
        return Ok(None);
    };
    let job_ids = parse_job_ids(output_ref)?;
    if let Some(job_id) = job_ids.first() {
        return collection_ref_for_job(db, *job_id).await.map(Some);
    }
    Ok(None)
}

async fn upstream_job_sources(
    db: &DatabaseState,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Vec<(i64, String)>, String> {
    let Some(dep) = node.depends_on.first() else {
        return Ok(vec![]);
    };
    let Some(output_ref) = node_outputs.get(dep) else {
        return Ok(vec![]);
    };
    let mut sources = Vec::new();
    for job_id in parse_job_ids(output_ref)? {
        sources.push((job_id, collection_ref_for_job(db, job_id).await?));
    }
    Ok(sources)
}

async fn run_job_agent(
    app: &AppHandle,
    db: &DatabaseState,
    execution_id: i64,
    node_id: &str,
    job_id: i64,
) -> Result<String, String> {
    let executor = JobExecutor::from_database(db.clone())?;
    executor.start_job(job_id).await?;
    let job = crate::database::get_inference_job_by_id(&db.pool(), job_id)
        .await?
        .ok_or("Method agent job not found")?;
    let config = WorkerConfig::from_job(job);
    let (tx, mut rx) = mpsc::channel::<JobEvent>(100);
    let exec_clone = executor.clone();
    let handle = tokio::spawn(async move { exec_clone.execute_job(config, tx).await });

    let mut final_error = None;
    let mut final_status = "completed".to_string();
    while let Some(event) = rx.recv().await {
        match &event {
            JobEvent::Completed { failure_count, .. } => {
                final_status = if *failure_count > 0 {
                    "completed_with_errors".into()
                } else {
                    "completed".into()
                };
            }
            JobEvent::Failed { error, .. } => {
                final_status = "failed".into();
                final_error = Some(error.clone());
            }
            JobEvent::Cancelled { .. } => {
                final_status = "cancelled".into();
            }
            _ => {}
        }
        insert_event(
            app,
            db,
            execution_id,
            Some(node_id),
            "node_job_event",
            serde_json::to_value(event).unwrap_or_else(|_| serde_json::json!({})),
        )
        .await?;
    }
    handle.await.map_err(|e| format!("Method agent task failed: {}", e))??;

    match final_status.as_str() {
        "completed" => {
            crate::database::update_job_status(&db.pool(), job_id, "completed").await?;
        }
        "completed_with_errors" => {
            crate::database::update_job_status(&db.pool(), job_id, "completed_with_errors").await?;
        }
        "cancelled" => {
            crate::database::update_job_status(&db.pool(), job_id, "cancelled").await?;
            return Err("Agent job was cancelled".into());
        }
        _ => {
            let error = final_error.unwrap_or_else(|| "Agent job failed".into());
            crate::database::update_job_status_with_error(&db.pool(), job_id, &error).await?;
            return Err(error);
        }
    }
    insert_artifact(db, execution_id, Some(node_id), "job", "inference_job", &job_id.to_string())
        .await
}

fn yaml_string_list(value: Option<&serde_yaml::Value>) -> Vec<String> {
    match value {
        Some(serde_yaml::Value::Sequence(items)) => {
            items.iter().filter_map(|item| yaml_string(Some(item))).collect()
        }
        Some(serde_yaml::Value::String(s)) => vec![s.clone()],
        _ => vec![],
    }
}

fn model_values(method: &MethodManifest) -> Vec<String> {
    yaml_string_list(yaml_lookup(&method.parameters, "model_values"))
}

async fn run_inference_agent(
    app: &AppHandle,
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
) -> Result<String, String> {
    let models = model_values(method);
    if models.len() <= 1 {
        let model_name = models
            .first()
            .cloned()
            .or_else(|| config_string(node, method, "model", Some("")))
            .unwrap_or_default();
        let job_id = create_inference_job_for_node(
            db,
            method,
            node,
            execution_id,
            models.first().map(String::as_str),
            None,
        )
        .await?;
        insert_event(
            app,
            db,
            execution_id,
            Some(&node.id),
            "inference_job_created",
            serde_json::json!({
                "jobId": job_id,
                "model": model_name,
                "samples": config_i32(node, method, "samples", Some(1)).unwrap_or(1),
            }),
        )
        .await?;
        return run_job_agent(app, db, execution_id, &node.id, job_id).await;
    }

    let mut job_ids = Vec::new();
    for model in models {
        insert_event(
            app,
            db,
            execution_id,
            Some(&node.id),
            "sweep_model_started",
            serde_json::json!({ "model": model }),
        )
        .await?;
        let job_id = create_inference_job_for_node(
            db,
            method,
            node,
            execution_id,
            Some(&model),
            Some(&slug_for_ref(&model)),
        )
        .await?;
        insert_event(
            app,
            db,
            execution_id,
            Some(&node.id),
            "inference_job_created",
            serde_json::json!({
                "jobId": job_id,
                "model": model,
                "samples": config_i32(node, method, "samples", Some(1)).unwrap_or(1),
            }),
        )
        .await?;
        run_job_agent(app, db, execution_id, &node.id, job_id).await?;
        job_ids.push(job_id);
    }
    let storage_ref = job_ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
    insert_artifact(db, execution_id, Some(&node.id), "job_set", "job_set", &storage_ref).await?;
    Ok(format!("job_set:{}", storage_ref))
}

fn slug_for_ref(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase()
}

async fn run_transform_agent(
    app: &AppHandle,
    db: &DatabaseState,
    method: &MethodManifest,
    node: &MethodWorkflowNode,
    execution_id: i64,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let upstream_sources = upstream_job_sources(db, node, node_outputs).await?;
    if upstream_sources.is_empty() {
        let upstream_source = upstream_collection_source(db, node, node_outputs).await?;
        let job_id =
            create_transform_job_for_node(db, method, node, execution_id, upstream_source, None)
                .await?;
        return run_job_agent(app, db, execution_id, &node.id, job_id).await;
    }

    let mut job_ids = Vec::new();
    for (source_job_id, source) in upstream_sources {
        let job_id = create_transform_job_for_node(
            db,
            method,
            node,
            execution_id,
            Some(source),
            Some(&format!("from-{}", source_job_id)),
        )
        .await?;
        run_job_agent(app, db, execution_id, &node.id, job_id).await?;
        job_ids.push(job_id);
    }
    let storage_ref = job_ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
    insert_artifact(db, execution_id, Some(&node.id), "job_set", "job_set", &storage_ref).await?;
    Ok(format!("job_set:{}", storage_ref))
}

async fn collection_items_for_job(
    db: &DatabaseState,
    job_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let collection_id: i64 = sqlx::query_scalar("SELECT id FROM collections WHERE job_id = ?1")
        .bind(job_id)
        .fetch_one(&db.pool())
        .await
        .map_err(|e| format!("Failed to find collection for job {}: {}", job_id, e))?;
    sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT data FROM collection_items WHERE collection_id = ?1 ORDER BY id ASC",
    )
    .bind(collection_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to read collection items: {}", e))
}

async fn job_model(db: &DatabaseState, job_id: i64) -> Result<String, String> {
    sqlx::query_scalar::<_, String>("SELECT model FROM inference_jobs WHERE id = ?1")
        .bind(job_id)
        .fetch_one(&db.pool())
        .await
        .map_err(|e| format!("Failed to read job model: {}", e))
}

fn item_passed(item: &serde_json::Value) -> Option<bool> {
    let obj = item.as_object()?;
    for key in ["pass", "passed", "success", "correct"] {
        if let Some(value) = obj.get(key).and_then(|value| value.as_bool()) {
            return Some(value);
        }
    }
    None
}

async fn run_aggregate_agent(
    db: &DatabaseState,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let Some(dep) = node.depends_on.first() else {
        return Err("Aggregate node needs an upstream dependency".into());
    };
    let output_ref = node_outputs
        .get(dep)
        .ok_or_else(|| format!("Aggregate dependency '{}' has no output", dep))?;
    let job_ids = parse_job_ids(output_ref)?;
    let mut groups = serde_json::Map::new();
    for job_id in job_ids {
        let model = job_model(db, job_id).await.unwrap_or_else(|_| format!("job-{}", job_id));
        let items = collection_items_for_job(db, job_id).await?;
        let total = items.len();
        let scored = items.iter().filter_map(item_passed).collect::<Vec<_>>();
        let passed = scored.iter().filter(|value| **value).count();
        let success_rate = if scored.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!(passed as f64 / scored.len() as f64)
        };
        groups.insert(
            model,
            serde_json::json!({
                "job_id": job_id,
                "total_items": total,
                "scored_items": scored.len(),
                "passed": passed,
                "success_rate": success_rate,
            }),
        );
    }
    let aggregate = serde_json::json!({
        "source": output_ref,
        "groups": groups,
    });
    let storage_ref = serde_json::to_string_pretty(&aggregate)
        .map_err(|e| format!("Failed to serialize aggregate: {}", e))?;
    insert_artifact(db, execution_id, Some(&node.id), "aggregate", "inline_json", &storage_ref)
        .await
}

async fn run_analysis_agent(
    db: &DatabaseState,
    execution_id: i64,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<String, String> {
    let mut body = String::from("# Analysis Draft\n\n");
    if let Some(dep) = node.depends_on.first().and_then(|dep| node_outputs.get(dep)) {
        body.push_str("This draft was generated from the Method execution artifacts.\n\n");
        body.push_str("## Source\n\n");
        body.push_str(dep);
        body.push_str("\n\n");
        if let Some(json) = dep.strip_prefix("inline_json:") {
            body.push_str("## Aggregate\n\n```json\n");
            body.push_str(json);
            body.push_str("\n```\n");
        }
    } else {
        body.push_str("No upstream aggregate artifact was available.\n");
    }
    insert_artifact(db, execution_id, Some(&node.id), "analysis", "inline_markdown", &body).await
}

async fn run_not_implemented_agent(
    db: &DatabaseState,
    execution_id: i64,
    node: &MethodWorkflowNode,
) -> Result<String, String> {
    insert_artifact(
        db,
        execution_id,
        Some(&node.id),
        "not_implemented",
        "inline",
        &format!(
            "{} agent is not implemented yet. The node was recorded with scoped status for this execution.",
            node.node_type
        ),
    )
    .await
}

async fn wait_if_paused(
    app: &AppHandle,
    db: &DatabaseState,
    execution_id: i64,
    control: &MethodExecutionControl,
) -> Result<(), String> {
    let mut emitted = false;
    while control.pause_requested.load(Ordering::SeqCst) {
        if control.cancel_requested.load(Ordering::SeqCst) {
            return Err("Execution cancelled".into());
        }
        if !emitted {
            update_execution_status(db, execution_id, "paused", None).await?;
            insert_event(app, db, execution_id, None, "execution_paused", serde_json::json!({}))
                .await?;
            emitted = true;
        }
        sleep(Duration::from_millis(250)).await;
    }
    if emitted {
        update_execution_status(db, execution_id, "running", None).await?;
        insert_event(app, db, execution_id, None, "execution_resumed", serde_json::json!({}))
            .await?;
    }
    Ok(())
}

async fn orchestrate_method_execution(
    app: AppHandle,
    db: DatabaseState,
    execution_id: i64,
    method: MethodManifest,
    control: MethodExecutionControl,
) -> Result<(), String> {
    update_execution_status(&db, execution_id, "running", None).await?;
    insert_event(
        &app,
        &db,
        execution_id,
        None,
        "execution_started",
        serde_json::json!({ "methodId": method.id }),
    )
    .await?;

    let mut had_not_implemented = false;
    let mut node_outputs: HashMap<String, String> = HashMap::new();
    for node in topological_nodes(&method.workflow.nodes)? {
        wait_if_paused(&app, &db, execution_id, &control).await?;
        if control.cancel_requested.load(Ordering::SeqCst) {
            update_node_status(&db, execution_id, &node.id, "cancelled", None, None).await?;
            update_execution_status(&db, execution_id, "cancelled", None).await?;
            insert_event(
                &app,
                &db,
                execution_id,
                Some(&node.id),
                "execution_cancelled",
                serde_json::json!({}),
            )
            .await?;
            return Ok(());
        }
        update_node_status(&db, execution_id, &node.id, "running", None, None).await?;
        insert_event(
            &app,
            &db,
            execution_id,
            Some(&node.id),
            "node_started",
            serde_json::json!({ "nodeType": node.node_type }),
        )
        .await?;

        let result = match node.node_type.as_str() {
            "inference" => run_inference_agent(&app, &db, &method, &node, execution_id).await,
            "transform" => {
                run_transform_agent(&app, &db, &method, &node, execution_id, &node_outputs).await
            }
            "eval"
                if method_file_by_kind(&method, "script").is_some()
                    || config_string(&node, &method, "script_file", None).is_some() =>
            {
                run_transform_agent(&app, &db, &method, &node, execution_id, &node_outputs).await
            }
            "aggregate" => run_aggregate_agent(&db, execution_id, &node, &node_outputs).await,
            "analysis" => run_analysis_agent(&db, execution_id, &node, &node_outputs).await,
            "eval" => {
                had_not_implemented = true;
                let artifact = run_not_implemented_agent(&db, execution_id, &node).await?;
                update_node_status(
                    &db,
                    execution_id,
                    &node.id,
                    "not_implemented",
                    Some(&artifact),
                    Some("Agent implementation is not available yet"),
                )
                .await?;
                insert_event(
                    &app,
                    &db,
                    execution_id,
                    Some(&node.id),
                    "node_not_implemented",
                    serde_json::json!({ "nodeType": node.node_type, "artifact": artifact }),
                )
                .await?;
                continue;
            }
            other => Err(format!("Unknown method node type '{}'", other)),
        };

        match result {
            Ok(output_ref) => {
                node_outputs.insert(node.id.clone(), output_ref.clone());
                update_node_status(
                    &db,
                    execution_id,
                    &node.id,
                    "completed",
                    Some(&output_ref),
                    None,
                )
                .await?;
                insert_event(
                    &app,
                    &db,
                    execution_id,
                    Some(&node.id),
                    "node_completed",
                    serde_json::json!({ "outputRef": output_ref }),
                )
                .await?;
            }
            Err(e) => {
                update_node_status(&db, execution_id, &node.id, "failed", None, Some(&e)).await?;
                update_execution_status(&db, execution_id, "failed", Some(&e)).await?;
                insert_event(
                    &app,
                    &db,
                    execution_id,
                    Some(&node.id),
                    "node_failed",
                    serde_json::json!({ "error": e }),
                )
                .await?;
                return Ok(());
            }
        }
    }

    let status = if had_not_implemented { "completed_with_errors" } else { "completed" };
    update_execution_status(&db, execution_id, status, None).await?;
    insert_event(
        &app,
        &db,
        execution_id,
        None,
        "execution_completed",
        serde_json::json!({ "status": status }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn execute_method(
    app: AppHandle,
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    id: String,
) -> Result<i64, String> {
    validate_method_id(&id)?;
    let root = project_root(&db)?;
    let folder = method_dir(&root, &id);
    let method = read_manifest(&folder)?;
    validate_method(&method)?;
    let content_hash = hash_directory(&folder)?;
    let execution_id = insert_execution(&db, &method, &content_hash).await?;
    let control = MethodExecutionControl::new();
    manager.controls.lock().await.insert(execution_id, control.clone());

    let app_handle = app.clone();
    let db_state = (*db).clone();
    let manager_state = manager.inner().controls.clone();
    tokio::spawn(async move {
        if let Err(e) = orchestrate_method_execution(
            app_handle.clone(),
            db_state.clone(),
            execution_id,
            method,
            control,
        )
        .await
        {
            let _ = update_execution_status(&db_state, execution_id, "failed", Some(&e)).await;
            let _ = insert_event(
                &app_handle,
                &db_state,
                execution_id,
                None,
                "execution_failed",
                serde_json::json!({ "error": e }),
            )
            .await;
        }
        manager_state.lock().await.remove(&execution_id);
    });

    Ok(execution_id)
}

#[tauri::command]
pub async fn list_method_executions(
    db: State<'_, DatabaseState>,
    method_id: Option<String>,
) -> Result<Vec<MethodExecutionSummary>, String> {
    if let Some(id) = method_id {
        sqlx::query_as::<_, MethodExecutionSummary>(
            r#"
            SELECT id, method_id, method_content_hash, status, error_message, created_at, started_at, completed_at
            FROM method_executions
            WHERE method_id = ?1
            ORDER BY created_at DESC
            "#,
        )
        .bind(id)
        .fetch_all(&db.pool())
        .await
        .map_err(|e| format!("Failed to list method executions: {}", e))
    } else {
        sqlx::query_as::<_, MethodExecutionSummary>(
            r#"
            SELECT id, method_id, method_content_hash, status, error_message, created_at, started_at, completed_at
            FROM method_executions
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&db.pool())
        .await
        .map_err(|e| format!("Failed to list method executions: {}", e))
    }
}

#[tauri::command]
pub async fn get_method_execution_nodes(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodExecutionNodeSummary>, String> {
    sqlx::query_as::<_, MethodExecutionNodeSummary>(
        r#"
        SELECT id, execution_id, node_id, node_type, status, output_ref, error_message, started_at, completed_at
        FROM method_execution_nodes
        WHERE execution_id = ?1
        ORDER BY id ASC
        "#,
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list method execution nodes: {}", e))
}

#[tauri::command]
pub async fn get_method_execution_events(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodExecutionEventSummary>, String> {
    sqlx::query_as::<_, MethodExecutionEventSummary>(
        r#"
        SELECT id, execution_id, node_id, event_type, payload_json, created_at
        FROM method_execution_events
        WHERE execution_id = ?1
        ORDER BY id ASC
        "#,
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list method execution events: {}", e))
}

#[tauri::command]
pub async fn get_method_execution_artifacts(
    db: State<'_, DatabaseState>,
    execution_id: i64,
) -> Result<Vec<MethodArtifactSummary>, String> {
    sqlx::query_as::<_, MethodArtifactSummary>(
        r#"
        SELECT id, execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash, created_at
        FROM method_artifacts
        WHERE execution_id = ?1
        ORDER BY id ASC
        "#,
    )
    .bind(execution_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list method execution artifacts: {}", e))
}

#[tauri::command]
pub async fn read_method_artifact(
    db: State<'_, DatabaseState>,
    artifact_id: i64,
) -> Result<String, String> {
    read_method_artifact_from_db(&db, artifact_id).await
}

#[tauri::command]
pub async fn pause_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    if let Some(control) = manager.controls.lock().await.get(&execution_id) {
        control.pause_requested.store(true, Ordering::SeqCst);
        update_execution_status(&db, execution_id, "pause_requested", None).await?;
        Ok(())
    } else {
        Err("Method execution is not active".into())
    }
}

#[tauri::command]
pub async fn resume_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    if let Some(control) = manager.controls.lock().await.get(&execution_id) {
        control.pause_requested.store(false, Ordering::SeqCst);
        update_execution_status(&db, execution_id, "running", None).await?;
        Ok(())
    } else {
        Err("Method execution is not active".into())
    }
}

#[tauri::command]
pub async fn cancel_method_execution(
    db: State<'_, DatabaseState>,
    manager: State<'_, MethodExecutionManager>,
    execution_id: i64,
) -> Result<(), String> {
    if let Some(control) = manager.controls.lock().await.get(&execution_id) {
        control.cancel_requested.store(true, Ordering::SeqCst);
        update_execution_status(&db, execution_id, "cancel_requested", None).await?;
        Ok(())
    } else {
        update_execution_status(&db, execution_id, "cancelled", None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_method() -> MethodManifest {
        MethodManifest {
            schema_version: 1,
            id: "edge-method".into(),
            title: "Edge method".into(),
            objective: Some("Compare local models".into()),
            files: vec![MethodFileRef {
                id: "prompt".into(),
                kind: "prompt".into(),
                path: "prompts/main.jinja2".into(),
            }],
            workflow: MethodWorkflow {
                nodes: vec![
                    MethodWorkflowNode {
                        id: "generate".into(),
                        node_type: "inference".into(),
                        depends_on: vec![],
                        config: serde_yaml::Value::Null,
                    },
                    MethodWorkflowNode {
                        id: "aggregate".into(),
                        node_type: "aggregate".into(),
                        depends_on: vec!["generate".into()],
                        config: serde_yaml::Value::Null,
                    },
                ],
            },
            parameters: serde_yaml::Value::Null,
            provider: serde_yaml::Value::Null,
        }
    }

    #[test]
    fn validate_method_rejects_cycles() {
        let mut method = sample_method();
        method.workflow.nodes[0].depends_on = vec!["aggregate".into()];

        let err = validate_method(&method).unwrap_err();

        assert!(err.contains("cycle"), "got: {err}");
    }

    #[test]
    fn validate_method_rejects_secret_values() {
        let mut method = sample_method();
        method.provider = serde_yaml::from_str("api_key: sk-test").unwrap();

        let err = validate_method(&method).unwrap_err();

        assert!(err.contains("secret-like"), "got: {err}");
    }

    #[tokio::test]
    async fn save_method_rejects_pre_frozen_file_paths() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-prefrozen-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let db = DatabaseState::new(&temp).await.unwrap();
        let mut method = sample_method();
        method.files[0].path = "files/already-frozen.jinja2".into();

        let err = save_method_to_project(&db, &temp, method).await.unwrap_err();

        assert!(err.contains("project file before save"), "got: {err}");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn freeze_files_rewrites_to_content_addressed_paths() {
        let temp = std::env::temp_dir().join(format!("nightshift-method-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join("prompts")).unwrap();
        fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
        let dest = temp.join("methods/edge-method");
        let mut method = sample_method();

        freeze_files(&mut method, &temp, &dest).unwrap();

        assert!(method.files[0].path.starts_with("files/"));
        assert!(dest.join(&method.files[0].path).is_file());
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn save_method_persists_metadata_and_frozen_manifest() {
        let temp =
            std::env::temp_dir().join(format!("nightshift-method-db-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join("prompts")).unwrap();
        fs::create_dir_all(temp.join("data")).unwrap();
        fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
        fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
        let db = DatabaseState::new(&temp).await.unwrap();
        let mut method = sample_method();
        method.files.push(MethodFileRef {
            id: "data".into(),
            kind: "data".into(),
            path: "data/examples.jsonl".into(),
        });
        method.provider = serde_yaml::from_str("model: bonsai-8b").unwrap();

        let summary = save_method_to_project(&db, &temp, method).await.unwrap();
        let listed = sqlx::query_as::<_, MethodSummary>(
            "SELECT id, title, content_hash, folder_path, created_at FROM methods",
        )
        .fetch_all(&db.pool())
        .await
        .unwrap();
        let manifest = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "edge-method");
        assert_eq!(listed[0].content_hash, summary.content_hash);
        assert!(manifest.files[0].path.starts_with("files/"));
        assert!(PathBuf::from(&summary.folder_path).join(&manifest.files[0].path).is_file());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn topological_nodes_orders_dependencies_first() {
        let method = sample_method();

        let ordered = topological_nodes(&method.workflow.nodes).unwrap();

        assert_eq!(
            ordered.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
            vec!["generate", "aggregate",]
        );
    }

    #[test]
    fn preflight_reports_missing_required_files() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-preflight-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let mut method = sample_method();
        method.files = vec![];

        let result = preflight_method_for_root(&method, &temp);

        assert_eq!(result.status, "drafting");
        assert!(result.blockers.iter().any(|blocker| blocker.code == "missing_file"
            && blocker.file_kind.as_deref() == Some("prompt")));
        assert!(result.blockers.iter().any(|blocker| blocker.code == "missing_file"
            && blocker.file_kind.as_deref() == Some("data")));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn preflight_is_ready_when_required_files_exist() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-preflight-ready-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join("prompts")).unwrap();
        fs::create_dir_all(temp.join("data")).unwrap();
        fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
        fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
        let mut method = sample_method();
        method.files.push(MethodFileRef {
            id: "data".into(),
            kind: "data".into(),
            path: "data/examples.jsonl".into(),
        });
        method.provider = serde_yaml::from_str("model: bonsai-8b").unwrap();

        let result = preflight_method_for_root(&method, &temp);

        assert_eq!(result.status, "ready");
        assert!(result.blockers.is_empty());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn extract_json_response_parses_agent_output() {
        let output = extract_json_response(
            r#"{"message":"Drafted","method":null,"questions":["Which prompt file?"]}"#,
        )
        .unwrap();

        assert_eq!(output.message, "Drafted");
        assert_eq!(output.questions, vec!["Which prompt file?"]);
        assert!(output.method.is_none());
    }

    #[tokio::test]
    async fn insert_execution_creates_node_rows() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-execution-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join("prompts")).unwrap();
        fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
        let db = DatabaseState::new(&temp).await.unwrap();
        let method = sample_method();

        let execution_id = insert_execution(&db, &method, "hash").await.unwrap();
        let nodes = sqlx::query_as::<_, MethodExecutionNodeSummary>(
            "SELECT id, execution_id, node_id, node_type, status, output_ref, error_message, started_at, completed_at FROM method_execution_nodes WHERE execution_id = ? ORDER BY id",
        )
        .bind(execution_id)
        .fetch_all(&db.pool())
        .await
        .unwrap();

        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].node_id, "generate");
        assert_eq!(nodes[0].status, "queued");
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn create_inference_job_for_node_uses_frozen_method_files() {
        let temp =
            std::env::temp_dir().join(format!("nightshift-method-job-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join("prompts")).unwrap();
        fs::create_dir_all(temp.join("data")).unwrap();
        fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
        fs::write(temp.join("data/examples.jsonl"), r#"{"name":"Ada"}"#).unwrap();
        let db = DatabaseState::new(&temp).await.unwrap();
        let mut method = sample_method();
        method.files.push(MethodFileRef {
            id: "data".into(),
            kind: "data".into(),
            path: "data/examples.jsonl".into(),
        });
        method.provider = serde_yaml::from_str(
            r#"
provider: Local
server_url: http://localhost:1234
model: qwen-test
"#,
        )
        .unwrap();

        let summary = save_method_to_project(&db, &temp, method).await.unwrap();
        let frozen = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();
        let execution_id = insert_execution(&db, &frozen, &summary.content_hash).await.unwrap();
        let job_id = create_inference_job_for_node(
            &db,
            &frozen,
            &frozen.workflow.nodes[0],
            execution_id,
            None,
            None,
        )
        .await
        .unwrap();
        let job =
            crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

        assert!(job.prompt_file.starts_with("methods/edge-method/files/"));
        assert!(job.data_source.starts_with("methods/edge-method/files/"));
        assert_eq!(job.model, "qwen-test");
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn create_transform_job_for_node_uses_frozen_script_and_data() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-transform-job-test-{}", Uuid::new_v4()));
        fs::create_dir_all(temp.join("data")).unwrap();
        fs::create_dir_all(temp.join("scripts")).unwrap();
        fs::write(temp.join("prompts-main-placeholder"), "").unwrap();
        fs::write(temp.join("data/examples.jsonl"), r#"{"value":1}"#).unwrap();
        fs::write(temp.join("scripts/score.js"), "return item;").unwrap();
        let db = DatabaseState::new(&temp).await.unwrap();
        let mut method = sample_method();
        method.files = vec![
            MethodFileRef {
                id: "data".into(),
                kind: "data".into(),
                path: "data/examples.jsonl".into(),
            },
            MethodFileRef {
                id: "script".into(),
                kind: "script".into(),
                path: "scripts/score.js".into(),
            },
        ];
        method.workflow.nodes = vec![MethodWorkflowNode {
            id: "score".into(),
            node_type: "transform".into(),
            depends_on: vec![],
            config: serde_yaml::Value::Null,
        }];

        let summary = save_method_to_project(&db, &temp, method).await.unwrap();
        let frozen = read_manifest(&PathBuf::from(&summary.folder_path)).unwrap();
        let execution_id = insert_execution(&db, &frozen, &summary.content_hash).await.unwrap();
        let job_id = create_transform_job_for_node(
            &db,
            &frozen,
            &frozen.workflow.nodes[0],
            execution_id,
            None,
            None,
        )
        .await
        .unwrap();
        let job =
            crate::database::get_inference_job_by_id(&db.pool(), job_id).await.unwrap().unwrap();

        assert_eq!(job.job_type, "transform");
        assert!(job.data_source.starts_with("methods/edge-method/files/"));
        assert!(job.transform_script_file.unwrap().starts_with("methods/edge-method/files/"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn model_values_reads_parameter_sweep() {
        let mut method = sample_method();
        method.parameters = serde_yaml::from_str(
            r#"
model_values:
  - bonsai-8b
  - qwen3.5-4b
"#,
        )
        .unwrap();

        assert_eq!(model_values(&method), vec!["bonsai-8b", "qwen3.5-4b"]);
    }

    #[tokio::test]
    async fn aggregate_agent_summarizes_pass_fields_by_job_model() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-aggregate-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let db = DatabaseState::new(&temp).await.unwrap();
        let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();

        let job_id = sqlx::query(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, status
            )
            VALUES ('inference', 'agg-job', 'p', 'd', 'Local', 'bonsai-8b', 'http://localhost:1234',
                'Unstructured', 1, 'single', 'completed')
            "#,
        )
        .execute(&db.pool())
        .await
        .unwrap()
        .last_insert_rowid();
        let collection_id =
            sqlx::query("INSERT INTO collections (job_id, name) VALUES (?1, 'outputs')")
                .bind(job_id)
                .execute(&db.pool())
                .await
                .unwrap()
                .last_insert_rowid();
        for item in [serde_json::json!({ "pass": true }), serde_json::json!({ "pass": false })] {
            sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?1, ?2)")
                .bind(collection_id)
                .bind(item)
                .execute(&db.pool())
                .await
                .unwrap();
        }
        let mut node_outputs = HashMap::new();
        node_outputs.insert("score".to_string(), format!("inference_job:{}", job_id));
        let node = MethodWorkflowNode {
            id: "aggregate".into(),
            node_type: "aggregate".into(),
            depends_on: vec!["score".into()],
            config: serde_yaml::Value::Null,
        };

        let output_ref =
            run_aggregate_agent(&db, execution_id, &node, &node_outputs).await.unwrap();

        assert!(output_ref.starts_with("inline_json:"));
        assert!(output_ref.contains("bonsai-8b"));
        assert!(output_ref.contains("\"success_rate\": 0.5"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[tokio::test]
    async fn read_method_artifact_returns_inline_content() {
        let temp = std::env::temp_dir()
            .join(format!("nightshift-method-artifact-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let db = DatabaseState::new(&temp).await.unwrap();
        let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
        insert_artifact(
            &db,
            execution_id,
            Some("analysis"),
            "analysis",
            "inline_markdown",
            "# Analysis",
        )
        .await
        .unwrap();
        let artifact = sqlx::query_as::<_, MethodArtifactSummary>(
            "SELECT id, execution_id, node_id, artifact_type, storage_kind, storage_ref, content_hash, created_at FROM method_artifacts WHERE execution_id = ?",
        )
        .bind(execution_id)
        .fetch_one(&db.pool())
        .await
        .unwrap();
        let content = read_method_artifact_from_db(&db, artifact.id).await.unwrap();

        assert_eq!(content, "# Analysis");
        assert_eq!(artifact.artifact_type, "analysis");
        fs::remove_dir_all(temp).unwrap();
    }
}
