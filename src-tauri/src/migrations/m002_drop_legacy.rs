//! m002 — drop the legacy single-job tables and rename collection_v2 to its
//! final name. After this migration the orchestrator owns `collection` and
//! `collection_item`; the legacy `inference_jobs`, `job_failures`,
//! `collections`, `collection_items` are gone.
//!
//! Per design, this is a one-way greenfield cutover — there is no data
//! migration. Users who had legacy rows lose them. The migration is robust
//! against partial state: each step uses `IF EXISTS` (or its semantic
//! equivalent for ALTER) so re-applies and partial-success-then-retry both
//! end at the same final shape.

use super::MigrationFuture;
use sqlx::SqlitePool;
use tracing::info;

pub fn up(pool: &SqlitePool) -> MigrationFuture<'_> {
    Box::pin(async move {
        // Disable FK enforcement for the duration of the structural changes
        // so dropping a parent (e.g. `inference_jobs`) doesn't fail if a
        // child (e.g. `collections`) was somehow dropped out of order on a
        // prior partial run. Restored at the end.
        sqlx::query("PRAGMA foreign_keys = OFF").execute(pool).await?;

        for stmt in &[
            "DROP TABLE IF EXISTS job_failures",
            "DROP TABLE IF EXISTS collection_items",
            "DROP TABLE IF EXISTS collections",
            "DROP TABLE IF EXISTS inference_jobs",
        ] {
            sqlx::query(stmt).execute(pool).await?;
        }

        // Idempotent rename: only rename when the source exists and the
        // target doesn't. Handles re-runs and the (hypothetical) case where
        // a previous attempt renamed one but not the other.
        rename_if_needed(pool, "collection_v2", "collection").await?;
        rename_if_needed(pool, "collection_item_v2", "collection_item").await?;

        sqlx::query("PRAGMA foreign_keys = ON").execute(pool).await?;
        Ok(())
    })
}

async fn rename_if_needed(
    pool: &SqlitePool,
    from: &str,
    to: &str,
) -> Result<(), sqlx::Error> {
    let from_exists = table_exists(pool, from).await?;
    let to_exists = table_exists(pool, to).await?;
    match (from_exists, to_exists) {
        (true, false) => {
            sqlx::query(&format!("ALTER TABLE {} RENAME TO {}", from, to))
                .execute(pool)
                .await?;
            info!(from, to, "m002 renamed table");
        }
        (false, true) => {
            // Already done.
        }
        (true, true) => {
            tracing::warn!(
                from,
                to,
                "m002 found both source and target tables; leaving as-is"
            );
        }
        (false, false) => {
            // Nothing to do — the orchestrator schema must have failed to
            // create. m001 should have errored before us in that case.
            tracing::warn!(from, to, "m002 found neither source nor target");
        }
    }
    Ok(())
}

async fn table_exists(pool: &SqlitePool, name: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
            .bind(name)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}
