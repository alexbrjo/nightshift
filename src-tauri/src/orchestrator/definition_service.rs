//! `DefinitionService` — single source of truth for definition CRUD and
//! content-addressed versioning. Identity (mutable: name, parent, position)
//! lives on `job_definition`; content (immutable: kind, params, input_ref,
//! description) is snapshotted into `job_definition_version` rows. Renames
//! and moves never produce a version; only content saves do.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;

use crate::database::DatabaseState;

const MAX_DEPTH: i64 = 8;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDefinition {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub root_id: i64,
    pub name: String,
    pub position: i64,
    pub current_version_id: Option<i64>,
    pub source: String,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDefinitionVersion {
    pub id: i64,
    pub definition_id: i64,
    pub parent_version_id: Option<i64>,
    pub content_hash: String,
    pub kind: String,
    pub mode: Option<String>,
    pub params: String,
    pub input_ref: Option<String>,
    pub description: Option<String>,
    pub message: Option<String>,
    pub created_by: String,
    pub triggered_by_execution_id: Option<i64>,
    pub created_at: String,
}

/// Input payload for `save_version`. The kind/mode/params/input_ref/description
/// tuple is what gets canonicalized and hashed; `message` is provenance only
/// and does not affect the hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionContent {
    pub kind: String,
    pub mode: Option<String>,
    pub params: serde_json::Value,
    pub input_ref: Option<serde_json::Value>,
    pub description: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionWithVersion {
    pub definition: JobDefinition,
    pub version: Option<JobDefinitionVersion>,
}

#[derive(Debug, thiserror::Error)]
pub enum DefinitionError {
    #[error("definition not found: id={0}")]
    NotFound(i64),
    #[error("invalid kind: {0}")]
    InvalidKind(String),
    #[error("invalid content: {0}")]
    InvalidContent(String),
    #[error("name conflict: {0}")]
    NameConflict(String),
    #[error("would create cycle: descendant {child} cannot become parent {proposed_parent}")]
    Cycle { child: i64, proposed_parent: i64 },
    #[error("depth limit exceeded (max {max})")]
    DepthExceeded { max: i64 },
    #[error("definitions missing saved versions: {0:?}")]
    UnsavedDefinitions(Vec<i64>),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Avoid leaking thiserror's internals across the Tauri boundary. Commands
/// translate `DefinitionError` into a `String`.
impl From<DefinitionError> for String {
    fn from(e: DefinitionError) -> Self {
        e.to_string()
    }
}

#[derive(Clone)]
pub struct DefinitionService {
    db: DatabaseState,
}

impl DefinitionService {
    pub fn new(db: DatabaseState) -> Self {
        Self { db }
    }

    /// Insert an identity row. Content is added later via `save_version`.
    /// Roots have `parent_id = None` and `root_id` is set to their own id
    /// post-insert. Children inherit the root from their parent.
    pub async fn create_definition(
        &self,
        parent_id: Option<i64>,
        name: String,
        position: i64,
    ) -> Result<i64, DefinitionError> {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return Err(DefinitionError::InvalidContent("name cannot be empty".into()));
        }
        let pool = self.db.pool();
        let mut tx = pool.begin().await?;

        let root_id_for_insert: Option<i64> = match parent_id {
            Some(pid) => {
                let parent: Option<(i64,)> =
                    sqlx::query_as("SELECT root_id FROM job_definition WHERE id = ?")
                        .bind(pid)
                        .fetch_optional(&mut *tx)
                        .await?;
                let (root,) = parent.ok_or(DefinitionError::NotFound(pid))?;
                Some(root)
            }
            None => None,
        };

        // Insert with placeholder root_id = 0; updated immediately after.
        let res = sqlx::query(
            r#"INSERT INTO job_definition (parent_id, root_id, name, position, source)
               VALUES (?, ?, ?, ?, 'user')"#,
        )
        .bind(parent_id)
        .bind(root_id_for_insert.unwrap_or(0))
        .bind(&trimmed)
        .bind(position)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            // surface uniqueness violations as NameConflict
            if e.to_string().contains("UNIQUE constraint") {
                DefinitionError::NameConflict(format!("name '{}' already exists", trimmed))
            } else {
                DefinitionError::Db(e)
            }
        })?;
        let id = res.last_insert_rowid();

        if root_id_for_insert.is_none() {
            sqlx::query("UPDATE job_definition SET root_id = id WHERE id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        Ok(id)
    }

    pub async fn read_current(&self, def_id: i64) -> Result<DefinitionWithVersion, DefinitionError> {
        let pool = self.db.pool();
        let definition: Option<JobDefinition> =
            sqlx::query_as("SELECT * FROM job_definition WHERE id = ?")
                .bind(def_id)
                .fetch_optional(&pool)
                .await?;
        let definition = definition.ok_or(DefinitionError::NotFound(def_id))?;

        let version = if let Some(vid) = definition.current_version_id {
            sqlx::query_as("SELECT * FROM job_definition_version WHERE id = ?")
                .bind(vid)
                .fetch_optional(&pool)
                .await?
        } else {
            None
        };

        Ok(DefinitionWithVersion { definition, version })
    }

    pub async fn read_version(
        &self,
        version_id: i64,
    ) -> Result<JobDefinitionVersion, DefinitionError> {
        let pool = self.db.pool();
        let v: Option<JobDefinitionVersion> =
            sqlx::query_as("SELECT * FROM job_definition_version WHERE id = ?")
                .bind(version_id)
                .fetch_optional(&pool)
                .await?;
        v.ok_or(DefinitionError::NotFound(version_id))
    }

    pub async fn list_versions(
        &self,
        def_id: i64,
    ) -> Result<Vec<JobDefinitionVersion>, DefinitionError> {
        let pool = self.db.pool();
        let rows = sqlx::query_as::<_, JobDefinitionVersion>(
            "SELECT * FROM job_definition_version WHERE definition_id = ? ORDER BY created_at ASC, id ASC",
        )
        .bind(def_id)
        .fetch_all(&pool)
        .await?;
        Ok(rows)
    }

    pub async fn list_roots(&self) -> Result<Vec<JobDefinition>, DefinitionError> {
        let pool = self.db.pool();
        let rows = sqlx::query_as::<_, JobDefinition>(
            "SELECT * FROM job_definition WHERE parent_id IS NULL AND deleted_at IS NULL \
             ORDER BY updated_at DESC, id DESC",
        )
        .fetch_all(&pool)
        .await?;
        Ok(rows)
    }

    pub async fn list_by_root(
        &self,
        root_id: i64,
    ) -> Result<Vec<JobDefinition>, DefinitionError> {
        let pool = self.db.pool();
        let rows = sqlx::query_as::<_, JobDefinition>(
            "SELECT * FROM job_definition WHERE root_id = ? AND deleted_at IS NULL \
             ORDER BY position ASC, id ASC",
        )
        .bind(root_id)
        .fetch_all(&pool)
        .await?;
        Ok(rows)
    }

    /// Save a new content version. Canonicalizes content to JSON with sorted
    /// keys, computes SHA-256, and dedups: if a version with that hash already
    /// exists for this definition, returns its id without inserting.
    pub async fn save_version(
        &self,
        def_id: i64,
        content: DefinitionContent,
        created_by: String,
        triggered_by_execution_id: Option<i64>,
    ) -> Result<(i64, bool), DefinitionError> {
        validate_content(&content)?;
        let canonical = canonical_content_json(&content);
        let content_hash = hash_string(&canonical);

        let pool = self.db.pool();
        let mut tx = pool.begin().await?;

        // Definition must exist.
        let exists: Option<(i64, Option<i64>)> =
            sqlx::query_as("SELECT id, current_version_id FROM job_definition WHERE id = ?")
                .bind(def_id)
                .fetch_optional(&mut *tx)
                .await?;
        let (_, current_version_id) = exists.ok_or(DefinitionError::NotFound(def_id))?;

        // Dedup against any prior version with the same hash for this def.
        let existing: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM job_definition_version \
             WHERE definition_id = ? AND content_hash = ?",
        )
        .bind(def_id)
        .bind(&content_hash)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some((existing_id,)) = existing {
            // Promote the dedup'd version to HEAD if it isn't already.
            if current_version_id != Some(existing_id) {
                sqlx::query(
                    "UPDATE job_definition SET current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                )
                .bind(existing_id)
                .bind(def_id)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            return Ok((existing_id, false));
        }

        let params_str = serde_json::to_string(&content.params)
            .map_err(|e| DefinitionError::InvalidContent(format!("params not serializable: {}", e)))?;
        let input_ref_str = match content.input_ref.as_ref() {
            Some(v) => Some(serde_json::to_string(v).map_err(|e| {
                DefinitionError::InvalidContent(format!("input_ref not serializable: {}", e))
            })?),
            None => None,
        };

        let res = sqlx::query(
            r#"INSERT INTO job_definition_version
                (definition_id, parent_version_id, content_hash, kind, mode,
                 params, input_ref, description, message, created_by, triggered_by_execution_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(def_id)
        .bind(current_version_id)
        .bind(&content_hash)
        .bind(&content.kind)
        .bind(content.mode.as_deref())
        .bind(&params_str)
        .bind(input_ref_str.as_deref())
        .bind(content.description.as_deref())
        .bind(content.message.as_deref())
        .bind(&created_by)
        .bind(triggered_by_execution_id)
        .execute(&mut *tx)
        .await?;
        let new_version_id = res.last_insert_rowid();

        sqlx::query(
            "UPDATE job_definition SET current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(new_version_id)
        .bind(def_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok((new_version_id, true))
    }

    pub async fn rename(&self, def_id: i64, new_name: String) -> Result<(), DefinitionError> {
        let trimmed = new_name.trim().to_string();
        if trimmed.is_empty() {
            return Err(DefinitionError::InvalidContent("name cannot be empty".into()));
        }
        let pool = self.db.pool();
        let res = sqlx::query(
            "UPDATE job_definition SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(&trimmed)
        .bind(def_id)
        .execute(&pool)
        .await
        .map_err(|e| {
            if e.to_string().contains("UNIQUE constraint") {
                DefinitionError::NameConflict(format!("name '{}' already exists", trimmed))
            } else {
                DefinitionError::Db(e)
            }
        })?;

        if res.rows_affected() == 0 {
            return Err(DefinitionError::NotFound(def_id));
        }
        Ok(())
    }

    /// Move under a new parent (None = promote to root) and/or change ordering.
    /// Validates: target is not a descendant; new total depth <= MAX_DEPTH.
    pub async fn move_(
        &self,
        def_id: i64,
        new_parent_id: Option<i64>,
        new_position: i64,
    ) -> Result<(), DefinitionError> {
        if Some(def_id) == new_parent_id {
            return Err(DefinitionError::Cycle {
                child: def_id,
                proposed_parent: def_id,
            });
        }

        let pool = self.db.pool();
        let mut tx = pool.begin().await?;

        // Subject row must exist.
        let subject: Option<(i64, Option<i64>)> =
            sqlx::query_as("SELECT id, parent_id FROM job_definition WHERE id = ?")
                .bind(def_id)
                .fetch_optional(&mut *tx)
                .await?;
        subject.ok_or(DefinitionError::NotFound(def_id))?;

        let new_root_id = if let Some(pid) = new_parent_id {
            // Cycle check via recursive CTE: is `pid` a descendant of `def_id`?
            let descendant: Option<(i64,)> = sqlx::query_as(
                r#"WITH RECURSIVE descendants(id) AS (
                       SELECT id FROM job_definition WHERE parent_id = ?
                       UNION ALL
                       SELECT j.id FROM job_definition j
                       INNER JOIN descendants d ON j.parent_id = d.id
                   )
                   SELECT id FROM descendants WHERE id = ?"#,
            )
            .bind(def_id)
            .bind(pid)
            .fetch_optional(&mut *tx)
            .await?;
            if descendant.is_some() {
                return Err(DefinitionError::Cycle { child: def_id, proposed_parent: pid });
            }

            // Depth: new_parent's depth + 1 + subject's max-descendant depth must be <= MAX_DEPTH.
            let parent_depth = depth_of(&mut *tx, pid).await?;
            let subject_subtree_depth = subtree_depth(&mut *tx, def_id).await?;
            if parent_depth + 1 + subject_subtree_depth > MAX_DEPTH {
                return Err(DefinitionError::DepthExceeded { max: MAX_DEPTH });
            }

            let parent: Option<(i64,)> =
                sqlx::query_as("SELECT root_id FROM job_definition WHERE id = ?")
                    .bind(pid)
                    .fetch_optional(&mut *tx)
                    .await?;
            let (root,) = parent.ok_or(DefinitionError::NotFound(pid))?;
            root
        } else {
            // Promoting to root: subject becomes its own root.
            def_id
        };

        sqlx::query(
            "UPDATE job_definition SET parent_id = ?, position = ?, root_id = ?, \
             updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(new_parent_id)
        .bind(new_position)
        .bind(new_root_id)
        .bind(def_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            if e.to_string().contains("UNIQUE constraint") {
                DefinitionError::NameConflict("name conflicts with sibling".into())
            } else {
                DefinitionError::Db(e)
            }
        })?;

        // Cascade root_id update to all descendants if it changed.
        sqlx::query(
            r#"WITH RECURSIVE subtree(id) AS (
                   SELECT id FROM job_definition WHERE id = ?
                   UNION ALL
                   SELECT j.id FROM job_definition j
                   INNER JOIN subtree s ON j.parent_id = s.id
               )
               UPDATE job_definition SET root_id = ?
               WHERE id IN (SELECT id FROM subtree)"#,
        )
        .bind(def_id)
        .bind(new_root_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn soft_delete(&self, def_id: i64) -> Result<(), DefinitionError> {
        let pool = self.db.pool();
        let res = sqlx::query(
            "UPDATE job_definition SET deleted_at = CURRENT_TIMESTAMP, \
             updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(def_id)
        .execute(&pool)
        .await?;
        if res.rows_affected() == 0 {
            // Either gone already or never existed; treat as not found for clarity.
            return Err(DefinitionError::NotFound(def_id));
        }
        Ok(())
    }

    /// Pre-flight check used by `experiment_start`: every non-deleted
    /// definition under `root_def_id` must have a current version. Returns
    /// the offending def_ids if any are unsaved.
    pub async fn ensure_all_versions_saved(
        &self,
        root_def_id: i64,
    ) -> Result<(), DefinitionError> {
        let pool = self.db.pool();
        let unsaved: Vec<(i64,)> = sqlx::query_as(
            "SELECT id FROM job_definition \
             WHERE root_id = ? AND deleted_at IS NULL AND current_version_id IS NULL \
             ORDER BY id ASC",
        )
        .bind(root_def_id)
        .fetch_all(&pool)
        .await?;
        if unsaved.is_empty() {
            Ok(())
        } else {
            Err(DefinitionError::UnsavedDefinitions(unsaved.into_iter().map(|(id,)| id).collect()))
        }
    }
}

async fn depth_of<'e, E>(executor: E, id: i64) -> Result<i64, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    // Depth-of-id = number of ancestors (root has depth 0).
    let row: (i64,) = sqlx::query_as(
        r#"WITH RECURSIVE ancestors(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM job_definition WHERE id = ?
               UNION ALL
               SELECT j.id, j.parent_id, a.depth + 1
               FROM job_definition j
               INNER JOIN ancestors a ON j.id = a.parent_id
           )
           SELECT COALESCE(MAX(depth), 0) FROM ancestors"#,
    )
    .bind(id)
    .fetch_one(executor)
    .await?;
    Ok(row.0)
}

async fn subtree_depth<'e, E>(executor: E, id: i64) -> Result<i64, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    // Max distance from `id` to any descendant (id itself has distance 0).
    let row: (i64,) = sqlx::query_as(
        r#"WITH RECURSIVE subtree(id, depth) AS (
               SELECT id, 0 FROM job_definition WHERE id = ?
               UNION ALL
               SELECT j.id, s.depth + 1
               FROM job_definition j
               INNER JOIN subtree s ON j.parent_id = s.id
           )
           SELECT COALESCE(MAX(depth), 0) FROM subtree"#,
    )
    .bind(id)
    .fetch_one(executor)
    .await?;
    Ok(row.0)
}

/// Recursively sort object keys so the JSON serialization is byte-stable.
/// Arrays preserve order; primitive values are passed through.
fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::with_capacity(map.len());
            for k in keys {
                out.insert(k.clone(), canonicalize(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

fn canonical_content_json(content: &DefinitionContent) -> String {
    // Hash the content tuple {kind, mode, params, input_ref, description}.
    // `message` is excluded — it's provenance, not content.
    let tuple = serde_json::json!({
        "kind": content.kind,
        "mode": content.mode,
        "params": content.params,
        "input_ref": content.input_ref,
        "description": content.description,
    });
    serde_json::to_string(&canonicalize(&tuple)).expect("canonical tuple is always serializable")
}

fn hash_string(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

/// Validate the kind and basic shape of `content`. Per design v1, kind-schema
/// validation is deliberately lightweight — we just check the kind is one of
/// the four reserved values and that `params` is an object (not an array or
/// scalar). Detailed per-kind schema checks land alongside the workers.
fn validate_content(content: &DefinitionContent) -> Result<(), DefinitionError> {
    match content.kind.as_str() {
        "group" | "inference" | "analysis" | "js_action" => {}
        other => return Err(DefinitionError::InvalidKind(other.into())),
    }
    if content.kind == "group" {
        match content.mode.as_deref() {
            Some("sequential") | Some("parallel") => {}
            Some(other) => {
                return Err(DefinitionError::InvalidContent(format!(
                    "group mode must be 'sequential' or 'parallel', got '{}'",
                    other
                )));
            }
            None => {
                return Err(DefinitionError::InvalidContent(
                    "group kind requires a mode".into(),
                ));
            }
        }
    }
    if !content.params.is_object() {
        return Err(DefinitionError::InvalidContent("params must be a JSON object".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::DatabaseState;
    use serde_json::json;
    use std::env;
    use std::fs;
    use std::sync::{Arc, Mutex, OnceLock};
    use uuid::Uuid;

    static TEST_LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    fn lock() -> &'static Arc<Mutex<()>> {
        TEST_LOCK.get_or_init(|| Arc::new(Mutex::new(())))
    }

    async fn fresh_service() -> (DefinitionService, std::path::PathBuf) {
        let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = env::temp_dir().join(format!("ns_def_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = DatabaseState::new(&dir).await.unwrap();
        (DefinitionService::new(db), dir)
    }

    fn cleanup(dir: &std::path::Path) {
        fs::remove_dir_all(dir).ok();
    }

    fn inference_content() -> DefinitionContent {
        DefinitionContent {
            kind: "inference".into(),
            mode: None,
            params: json!({"prompt_file": "p.j2", "samples": 1}),
            input_ref: Some(json!({"kind": "file", "path": "data.jsonl"})),
            description: None,
            message: None,
        }
    }

    #[tokio::test]
    async fn create_definition_inserts_identity_only() {
        let (svc, dir) = fresh_service().await;
        let id = svc.create_definition(None, "root1".into(), 0).await.unwrap();
        let dv = svc.read_current(id).await.unwrap();
        assert_eq!(dv.definition.name, "root1");
        assert!(dv.definition.parent_id.is_none());
        assert_eq!(dv.definition.root_id, id);
        assert!(dv.definition.current_version_id.is_none());
        assert!(dv.version.is_none());
        cleanup(&dir);
    }

    #[tokio::test]
    async fn save_version_creates_then_dedups() {
        let (svc, dir) = fresh_service().await;
        let id = svc.create_definition(None, "r".into(), 0).await.unwrap();
        let (v1, created) = svc
            .save_version(id, inference_content(), "user".into(), None)
            .await
            .unwrap();
        assert!(created);

        let (v1_again, created_again) = svc
            .save_version(id, inference_content(), "user".into(), None)
            .await
            .unwrap();
        assert_eq!(v1_again, v1);
        assert!(!created_again, "second save with same content must dedup");

        let mut other = inference_content();
        other.params = json!({"prompt_file": "p.j2", "samples": 2});
        let (v2, created) = svc.save_version(id, other, "user".into(), None).await.unwrap();
        assert!(created);
        assert_ne!(v2, v1);

        let history = svc.list_versions(id).await.unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].parent_version_id, Some(v1));
        cleanup(&dir);
    }

    #[tokio::test]
    async fn save_version_canonicalizes_key_order() {
        let (svc, dir) = fresh_service().await;
        let id = svc.create_definition(None, "r".into(), 0).await.unwrap();
        let mut a = inference_content();
        a.params = json!({"a": 1, "b": 2});
        let mut b = inference_content();
        b.params = json!({"b": 2, "a": 1}); // same content, keys reordered
        let (va, _) = svc.save_version(id, a, "user".into(), None).await.unwrap();
        let (vb, created) = svc.save_version(id, b, "user".into(), None).await.unwrap();
        assert_eq!(va, vb);
        assert!(!created);
        cleanup(&dir);
    }

    #[tokio::test]
    async fn save_version_rejects_invalid_kind() {
        let (svc, dir) = fresh_service().await;
        let id = svc.create_definition(None, "r".into(), 0).await.unwrap();
        let mut bad = inference_content();
        bad.kind = "bogus".into();
        let err = svc.save_version(id, bad, "user".into(), None).await.unwrap_err();
        assert!(matches!(err, DefinitionError::InvalidKind(_)));
        cleanup(&dir);
    }

    #[tokio::test]
    async fn save_version_requires_group_mode() {
        let (svc, dir) = fresh_service().await;
        let id = svc.create_definition(None, "r".into(), 0).await.unwrap();
        let bad = DefinitionContent {
            kind: "group".into(),
            mode: None,
            params: json!({}),
            input_ref: None,
            description: None,
            message: None,
        };
        let err = svc.save_version(id, bad, "user".into(), None).await.unwrap_err();
        assert!(matches!(err, DefinitionError::InvalidContent(_)));
        cleanup(&dir);
    }

    #[tokio::test]
    async fn rename_does_not_create_version() {
        let (svc, dir) = fresh_service().await;
        let id = svc.create_definition(None, "r".into(), 0).await.unwrap();
        svc.save_version(id, inference_content(), "user".into(), None).await.unwrap();
        svc.rename(id, "renamed".into()).await.unwrap();
        let history = svc.list_versions(id).await.unwrap();
        assert_eq!(history.len(), 1);
        let dv = svc.read_current(id).await.unwrap();
        assert_eq!(dv.definition.name, "renamed");
        cleanup(&dir);
    }

    #[tokio::test]
    async fn move_rejects_cycle() {
        let (svc, dir) = fresh_service().await;
        let r = svc.create_definition(None, "r".into(), 0).await.unwrap();
        let c = svc.create_definition(Some(r), "c".into(), 0).await.unwrap();
        // Move parent under its own child: cycle.
        let err = svc.move_(r, Some(c), 0).await.unwrap_err();
        assert!(matches!(err, DefinitionError::Cycle { .. }));
        cleanup(&dir);
    }

    #[tokio::test]
    async fn move_rejects_excessive_depth() {
        let (svc, dir) = fresh_service().await;
        // Build a chain of MAX_DEPTH+1 nodes to push past the limit.
        let mut last = svc.create_definition(None, "n0".into(), 0).await.unwrap();
        for i in 1..=MAX_DEPTH {
            last = svc.create_definition(Some(last), format!("n{}", i), 0).await.unwrap();
        }
        // last is at depth MAX_DEPTH (root is 0). Adding one more under last == depth MAX_DEPTH+1 > MAX_DEPTH.
        let extra = svc.create_definition(None, "extra".into(), 0).await.unwrap();
        let err = svc.move_(extra, Some(last), 0).await.unwrap_err();
        assert!(matches!(err, DefinitionError::DepthExceeded { .. }));
        cleanup(&dir);
    }

    #[tokio::test]
    async fn ensure_all_versions_saved_flags_unsaved() {
        let (svc, dir) = fresh_service().await;
        let r = svc.create_definition(None, "r".into(), 0).await.unwrap();
        let c = svc.create_definition(Some(r), "c".into(), 0).await.unwrap();
        // Neither has a version yet.
        let err = svc.ensure_all_versions_saved(r).await.unwrap_err();
        match err {
            DefinitionError::UnsavedDefinitions(ids) => {
                assert!(ids.contains(&r) && ids.contains(&c));
            }
            _ => panic!("expected UnsavedDefinitions"),
        }
        // Save versions for both; now passes.
        svc.save_version(r, inference_content(), "user".into(), None).await.unwrap();
        svc.save_version(c, inference_content(), "user".into(), None).await.unwrap();
        svc.ensure_all_versions_saved(r).await.unwrap();
        cleanup(&dir);
    }

    #[tokio::test]
    async fn soft_delete_marks_deleted_at() {
        let (svc, dir) = fresh_service().await;
        let id = svc.create_definition(None, "x".into(), 0).await.unwrap();
        svc.soft_delete(id).await.unwrap();
        let dv = svc.read_current(id).await.unwrap();
        assert!(dv.definition.deleted_at.is_some());
        // List roots should not include it.
        let roots = svc.list_roots().await.unwrap();
        assert!(roots.iter().all(|r| r.id != id));
        cleanup(&dir);
    }
}
