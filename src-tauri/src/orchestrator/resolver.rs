//! Resolves an `input_ref` (stored on a `job_definition_version`) to a
//! concrete stream of input rows at execution time. v1 supports `kind: 'file'`
//! only; checkpoint 6 adds sibling / siblings / concat / static / grid.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::warn;

use super::llm::resolve_within_project;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputRef {
    File { path: String },
    // siblings, sibling, concat, static, grid land in a later commit; treat
    // any unknown kind as an error rather than silently producing zero rows.
}

/// Parse a free-form `input_ref` JSON value into a typed `InputRef`. We keep
/// a forgiving parser so frontend mistakes surface clearly.
pub fn parse_input_ref(value: &serde_json::Value) -> Result<InputRef, String> {
    serde_json::from_value(value.clone())
        .map_err(|e| format!("Invalid input_ref ({}): {}", e, value))
}

/// Read rows from a project-relative file. Both JSON arrays and JSONL are
/// accepted; comment lines starting with `#` are ignored. Mirrors the legacy
/// `JobExecutor::load_file_samples` semantics so behavior is preserved.
pub async fn resolve_file(
    project_root: &Path,
    path: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let full_path = resolve_within_project(project_root, path)?;
    let content = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|e| format!("Failed to read data source {}: {}", path, e))?;

    let mut rows: Vec<serde_json::Value> = Vec::new();
    if content.trim().starts_with('[') {
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse JSON array from {}: {}", path, e))?;
        rows = parsed;
    } else {
        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            match serde_json::from_str(trimmed) {
                Ok(obj) => rows.push(obj),
                Err(e) => {
                    warn!("Failed to parse line {} in {}: {}", line_num + 1, path, e);
                }
            }
        }
    }
    Ok(rows)
}

pub async fn resolve(
    project_root: &Path,
    input_ref: &InputRef,
) -> Result<Vec<serde_json::Value>, String> {
    match input_ref {
        InputRef::File { path } => resolve_file(project_root, path).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn fresh_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ns_resolver_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_input_ref_accepts_file_kind() {
        let v = serde_json::json!({"kind": "file", "path": "data.jsonl"});
        let ir = parse_input_ref(&v).unwrap();
        match ir {
            InputRef::File { path } => assert_eq!(path, "data.jsonl"),
        }
    }

    #[test]
    fn parse_input_ref_rejects_unknown_kind() {
        let v = serde_json::json!({"kind": "siblings", "names": []});
        assert!(parse_input_ref(&v).is_err());
    }

    #[tokio::test]
    async fn resolve_file_reads_jsonl() {
        let root = fresh_root();
        fs::write(
            root.join("data.jsonl"),
            "{\"a\":1}\n{\"a\":2}\n# comment ignored\n\n{\"a\":3}\n",
        )
        .unwrap();
        let rows = resolve_file(&root, "data.jsonl").await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["a"], 1);
        assert_eq!(rows[2]["a"], 3);
        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn resolve_file_reads_json_array() {
        let root = fresh_root();
        fs::write(root.join("data.json"), "[{\"x\": \"a\"}, {\"x\": \"b\"}]").unwrap();
        let rows = resolve_file(&root, "data.json").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["x"], "b");
        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn resolve_file_rejects_path_escape() {
        let root = fresh_root();
        let err = resolve_file(&root, "../etc/passwd").await.unwrap_err();
        assert!(err.contains("'..'") || err.contains("escapes"));
        fs::remove_dir_all(&root).ok();
    }
}
