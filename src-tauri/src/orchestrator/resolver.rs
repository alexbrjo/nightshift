//! Resolves an `input_ref` (stored on a `job_definition_version`) to a
//! concrete stream of input rows at execution time.
//!
//! Two kinds are supported, the minimum needed to author a real pipeline
//! end-to-end:
//!   - `file`    — read JSONL/JSON from a project-relative path.
//!   - `sibling` — feed me the rows of a named sibling's completed collection
//!                 in the same run.
//!
//! The original design's `siblings` / `concat` / `static` / `grid` kinds were
//! removed in favor of shipping less. Add them back when there's a real call
//! site that needs them.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::warn;

use super::llm::resolve_within_project;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputRef {
    File { path: String },
    /// Pull rows from a single sibling's completed collection.
    Sibling { name: String },
}

pub fn parse_input_ref(value: &serde_json::Value) -> Result<InputRef, String> {
    serde_json::from_value(value.clone())
        .map_err(|e| format!("Invalid input_ref ({}): {}", e, value))
}

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
        rows = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse JSON array from {}: {}", path, e))?;
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

/// Find the collection id for a sibling definition (by name) within the same
/// run. Joins through the same root_id so multi-run definitions don't collide.
pub async fn find_sibling_collection(
    pool: &SqlitePool,
    parent_def_id: i64,
    sibling_name: &str,
    root_exec_id: i64,
) -> Result<Option<i64>, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT c.id \
         FROM job_definition d \
         JOIN job_execution e ON e.definition_version_id IN ( \
             SELECT id FROM job_definition_version WHERE definition_id = d.id \
         ) \
         JOIN collection c ON c.execution_id = e.id \
         WHERE d.parent_id = ? AND d.name = ? AND d.deleted_at IS NULL \
           AND e.root_id = ? AND e.status = 'completed' \
         ORDER BY e.id DESC LIMIT 1",
    )
    .bind(parent_def_id)
    .bind(sibling_name)
    .bind(root_exec_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id,)| id))
}

async fn collection_rows(
    pool: &SqlitePool,
    collection_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let rows: Vec<(Option<String>,)> = sqlx::query_as(
        "SELECT data FROM collection_item \
         WHERE collection_id = ? AND status = 'completed' \
         ORDER BY item_index ASC",
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to load collection items: {}", e))?;
    let mut out = Vec::with_capacity(rows.len());
    for (data_str,) in rows {
        if let Some(s) = data_str {
            match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(v) => out.push(v),
                Err(e) => warn!(error = %e, "skipping unparseable collection_item"),
            }
        }
    }
    Ok(out)
}

#[derive(Clone, Copy)]
pub struct ResolveContext<'a> {
    pub project_root: &'a Path,
    pub pool: &'a SqlitePool,
    /// The id of the current run's parent definition (so `sibling` looks up
    /// peers under the same group).
    pub parent_def_id: i64,
    /// The current run's root execution id.
    pub root_exec_id: i64,
}

pub async fn resolve(
    ctx: &ResolveContext<'_>,
    input_ref: &InputRef,
) -> Result<Vec<serde_json::Value>, String> {
    match input_ref {
        InputRef::File { path } => resolve_file(ctx.project_root, path).await,
        InputRef::Sibling { name } => {
            match find_sibling_collection(ctx.pool, ctx.parent_def_id, name, ctx.root_exec_id)
                .await
                .map_err(|e| format!("sibling lookup failed: {}", e))?
            {
                Some(cid) => collection_rows(ctx.pool, cid).await,
                None => Err(format!(
                    "sibling '{}' has no completed collection in this run",
                    name
                )),
            }
        }
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
    fn parse_input_ref_accepts_file() {
        let v = serde_json::json!({"kind": "file", "path": "data.jsonl"});
        assert!(matches!(parse_input_ref(&v).unwrap(), InputRef::File { .. }));
    }

    #[test]
    fn parse_input_ref_accepts_sibling() {
        let v = serde_json::json!({"kind": "sibling", "name": "gen-low"});
        assert!(matches!(parse_input_ref(&v).unwrap(), InputRef::Sibling { .. }));
    }

    #[test]
    fn parse_input_ref_rejects_unknown_kind() {
        for v in [
            serde_json::json!({"kind": "siblings", "names": ["a"]}),
            serde_json::json!({"kind": "concat", "sources": []}),
            serde_json::json!({"kind": "static", "collection_id": 1}),
            serde_json::json!({"kind": "grid", "dims": {}}),
            serde_json::json!({"kind": "garbage"}),
        ] {
            assert!(parse_input_ref(&v).is_err(), "should reject {}", v);
        }
    }

    #[tokio::test]
    async fn resolve_file_reads_jsonl() {
        let root = fresh_root();
        fs::write(
            root.join("data.jsonl"),
            "{\"a\":1}\n{\"a\":2}\n# comment\n\n{\"a\":3}\n",
        )
        .unwrap();
        let rows = resolve_file(&root, "data.jsonl").await.unwrap();
        assert_eq!(rows.len(), 3);
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
