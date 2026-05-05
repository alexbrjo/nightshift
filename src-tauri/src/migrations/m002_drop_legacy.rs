//! m002 — drop the legacy single-job tables and rename collection_v2 to its
//! final name. After this migration the orchestrator owns `collection` and
//! `collection_item`; the legacy `inference_jobs`, `job_failures`,
//! `collections`, `collection_items` are gone.
//!
//! Per design, this is a one-way greenfield cutover — there is no data
//! migration. Users who had legacy rows lose them. The `IF EXISTS` guards
//! make the migration idempotent across fresh installs (where the legacy
//! tables never existed) and existing installs.

use super::MigrationFuture;
use sqlx::SqlitePool;

pub fn up(pool: &SqlitePool) -> MigrationFuture<'_> {
    Box::pin(async move {
        // 1. Drop legacy tables (and their dependent indexes by extension).
        for stmt in &[
            "DROP TABLE IF EXISTS job_failures",
            "DROP TABLE IF EXISTS collection_items",
            "DROP TABLE IF EXISTS collections",
            "DROP TABLE IF EXISTS inference_jobs",
        ] {
            sqlx::query(stmt).execute(pool).await?;
        }

        // 2. Rename the orchestrator's _v2 tables to their final names.
        // SQLite's ALTER TABLE RENAME also fixes FK references in dependent
        // tables (the FK from collection_item_v2 → collection_v2 follows).
        // Index names retain their old prefix; that's cosmetic.
        sqlx::query("ALTER TABLE collection_v2 RENAME TO collection").execute(pool).await?;
        sqlx::query("ALTER TABLE collection_item_v2 RENAME TO collection_item")
            .execute(pool)
            .await?;

        Ok(())
    })
}
