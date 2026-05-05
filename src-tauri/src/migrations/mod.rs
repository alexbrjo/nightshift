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

pub type MigrationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'a>>;

pub struct Migration {
    pub version: i64,
    pub description: &'static str,
    pub up: for<'a> fn(&'a SqlitePool) -> MigrationFuture<'a>,
}

const MIGRATIONS: &[Migration] =
    &[Migration { version: 1, description: "orchestrator schema", up: m001_orchestrator::up }];

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
    async fn orchestrator_tables_exist_after_run() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await.unwrap();
        run(&pool).await.unwrap();

        for table in [
            "job_definition",
            "job_definition_version",
            "job_execution",
            "collection_v2",
            "collection_item_v2",
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
    }
}
