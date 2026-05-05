//! Resolves an `input_ref` (stored on a `job_definition_version`) to a
//! concrete stream of input rows at execution time. v1 supports all five
//! design kinds: file, sibling, siblings, concat, static, grid.
//!
//! `sibling` / `siblings` look up by *name*, so they're stable across
//! definition renames within a single run (executions pin to versions, not
//! identity, but the lookup happens against `root_id` of the current run).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::warn;

use super::llm::resolve_within_project;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputRef {
    File {
        path: String,
    },
    /// Pull rows from a single sibling's completed collection.
    Sibling {
        name: String,
    },
    /// Resolve a list of sibling names; consumers (analysis worker) use this
    /// for cross-collection SQL queries. The resolver itself returns nothing
    /// for this kind — analysis workers look up the collection ids directly.
    Siblings {
        names: Vec<String>,
    },
    /// Concatenate the rows of multiple sources in order.
    Concat {
        sources: Vec<InputRef>,
    },
    /// Pin to a specific past collection by id.
    Static {
        collection_id: i64,
    },
    /// Synthesize rows from a Cartesian product of named axes.
    Grid {
        dims: BTreeMap<String, Vec<serde_json::Value>>,
    },
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

async fn collection_rows(pool: &SqlitePool, collection_id: i64) -> Result<Vec<serde_json::Value>, String> {
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
        match data_str {
            Some(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(v) => out.push(v),
                Err(e) => warn!(error = %e, "skipping unparseable collection_item"),
            },
            None => {}
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

/// Materialize the rows for `input_ref`. Some kinds (siblings) deliberately
/// produce no rows — they're for downstream code that wants collection ids
/// rather than row streams.
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
        InputRef::Siblings { .. } => {
            // Analysis workers use the names list directly; the resolver
            // returns nothing here so generic iteration callers don't get a
            // misleading flat stream.
            Ok(Vec::new())
        }
        InputRef::Concat { sources } => {
            let mut out = Vec::new();
            for src in sources {
                let chunk = Box::pin(resolve(ctx, src)).await?;
                out.extend(chunk);
            }
            Ok(out)
        }
        InputRef::Static { collection_id } => collection_rows(ctx.pool, *collection_id).await,
        InputRef::Grid { dims } => Ok(grid_product(dims)),
    }
}

fn grid_product(dims: &BTreeMap<String, Vec<serde_json::Value>>) -> Vec<serde_json::Value> {
    let keys: Vec<&String> = dims.keys().collect();
    if keys.is_empty() {
        return Vec::new();
    }
    let mut current: Vec<serde_json::Map<String, serde_json::Value>> =
        vec![serde_json::Map::new()];
    for key in &keys {
        let values = &dims[*key];
        let mut next = Vec::with_capacity(current.len() * values.len());
        for partial in &current {
            for v in values {
                let mut row = partial.clone();
                row.insert(key.to_string(), v.clone());
                next.push(row);
            }
        }
        current = next;
    }
    current.into_iter().map(serde_json::Value::Object).collect()
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
        assert!(matches!(ir, InputRef::File { .. }));
    }

    #[test]
    fn parse_input_ref_accepts_sibling_concat_grid() {
        assert!(matches!(
            parse_input_ref(&serde_json::json!({"kind": "sibling", "name": "x"})).unwrap(),
            InputRef::Sibling { .. }
        ));
        assert!(matches!(
            parse_input_ref(&serde_json::json!({
                "kind": "concat",
                "sources": [
                    {"kind": "sibling", "name": "a"},
                    {"kind": "sibling", "name": "b"}
                ]
            }))
            .unwrap(),
            InputRef::Concat { .. }
        ));
        assert!(matches!(
            parse_input_ref(&serde_json::json!({
                "kind": "grid",
                "dims": {"temp": [0.1, 0.5], "top_p": [0.9]}
            }))
            .unwrap(),
            InputRef::Grid { .. }
        ));
    }

    #[test]
    fn parse_input_ref_rejects_unknown_kind() {
        let v = serde_json::json!({"kind": "garbage"});
        assert!(parse_input_ref(&v).is_err());
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

    #[test]
    fn grid_product_yields_cartesian() {
        let mut dims: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
        dims.insert("a".into(), vec![serde_json::json!(1), serde_json::json!(2)]);
        dims.insert("b".into(), vec![serde_json::json!("x"), serde_json::json!("y")]);
        let rows = grid_product(&dims);
        assert_eq!(rows.len(), 4);
        // BTreeMap orders keys lexically: a then b.
        let first = rows[0].as_object().unwrap();
        assert_eq!(first.get("a").unwrap(), &serde_json::json!(1));
        assert_eq!(first.get("b").unwrap(), &serde_json::json!("x"));
    }

    #[test]
    fn grid_product_empty_dims_returns_empty() {
        let dims = BTreeMap::new();
        assert!(grid_product(&dims).is_empty());
    }
}
