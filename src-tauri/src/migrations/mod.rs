//! Tiny ordered-migration framework backing the `schema_version` table.
//!
//! Every migration declares a numeric version and an `up` function. On startup
//! the runner loads the set of already-applied versions from `schema_version`
//! and runs any newer migration in order. Migrations are not transactional at
//! the framework level — purely-additive `CREATE TABLE` migrations are
//! idempotent by themselves; non-additive migrations are responsible for their
//! own atomicity (typically by opening a transaction inside their `up`).

use sqlx::SqlitePool;
use std::future::Future;
use std::pin::Pin;

mod m001_orchestrator;
mod m002_drop_legacy;

pub type MigrationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'a>>;

pub struct Migration {
    pub version: i64,
    pub description: &'static str,
    pub up: for<'a> fn(&'a SqlitePool) -> MigrationFuture<'a>,
}

const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, description: "orchestrator schema", up: m001_orchestrator::up },
    Migration { version: 2, description: "drop legacy tables", up: m002_drop_legacy::up },
];

pub async fn run(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (
            version     INTEGER PRIMARY KEY,
            applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            description TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    for m in MIGRATIONS {
        let already: Option<(i64,)> =
            sqlx::query_as("SELECT version FROM schema_version WHERE version = ?")
                .bind(m.version)
                .fetch_optional(pool)
                .await?;
        if already.is_some() {
            continue;
        }
        (m.up)(pool).await?;
        sqlx::query("INSERT INTO schema_version (version, description) VALUES (?, ?)")
            .bind(m.version)
            .bind(m.description)
            .execute(pool)
            .await?;
        tracing::info!(version = m.version, description = m.description, "applied migration");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_is_idempotent() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await.unwrap();
        run(&pool).await.unwrap();
        run(&pool).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, MIGRATIONS.len() as i64);
    }

    #[tokio::test]
    async fn run_upgrades_a_legacy_db_in_place() {
        // Simulates a user whose .nightshift/nightshift.db was created by
        // the legacy code: it has the four legacy tables and no
        // schema_version. The runner should apply m001 + m002 and end at
        // the canonical orchestrator shape with no legacy tables left.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await.unwrap();
        for ddl in &[
            "CREATE TABLE inference_jobs (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE collections (id INTEGER PRIMARY KEY, job_id INTEGER, \
             FOREIGN KEY (job_id) REFERENCES inference_jobs(id))",
            "CREATE TABLE collection_items (id INTEGER PRIMARY KEY, \
             collection_id INTEGER, FOREIGN KEY (collection_id) REFERENCES collections(id))",
            "CREATE TABLE job_failures (id INTEGER PRIMARY KEY, job_id INTEGER, \
             FOREIGN KEY (job_id) REFERENCES inference_jobs(id))",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }

        run(&pool).await.expect("upgrade migration succeeds");

        for legacy in ["inference_jobs", "job_failures", "collections", "collection_items"] {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .bind(legacy)
                    .fetch_optional(&pool)
                    .await
                    .unwrap();
            assert!(row.is_none(), "legacy table {} should be dropped", legacy);
        }
        for table in ["collection", "collection_item", "job_definition", "job_execution"] {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .bind(table)
                    .fetch_optional(&pool)
                    .await
                    .unwrap();
            assert!(row.is_some(), "{} should exist after upgrade", table);
        }
    }

    #[tokio::test]
    async fn orchestrator_tables_exist_after_run() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await.unwrap();
        run(&pool).await.unwrap();

        // After the cutover migration, the final names are in place and the
        // _v2 names + legacy tables are gone.
        for table in [
            "job_definition",
            "job_definition_version",
            "job_execution",
            "collection",
            "collection_item",
            "schema_version",
        ] {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .bind(table)
                    .fetch_optional(&pool)
                    .await
                    .unwrap();
            assert!(row.is_some(), "table {} should exist", table);
        }
        for legacy in ["inference_jobs", "job_failures", "collections", "collection_items"] {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .bind(legacy)
                    .fetch_optional(&pool)
                    .await
                    .unwrap();
            assert!(row.is_none(), "legacy table {} should be gone", legacy);
        }
    }
}
