//! m001 — orchestrator schema. Creates the six tables that back the
//! definition / version / execution / collection model. Additive only;
//! the legacy `inference_jobs` / `collections` / `collection_items` /
//! `job_failures` tables remain untouched and are dropped in a later
//! migration as part of the legacy cutover. Until then, `collection` and
//! `collection_item` use the `_v2` suffix to avoid clashing with the
//! legacy table names.

use super::MigrationFuture;
use sqlx::SqlitePool;

pub fn up(pool: &SqlitePool) -> MigrationFuture<'_> {
    Box::pin(async move {
        sqlx::query(
            r#"
            CREATE TABLE job_definition (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id           INTEGER REFERENCES job_definition(id),
                root_id             INTEGER NOT NULL REFERENCES job_definition(id),
                name                TEXT NOT NULL,
                position            INTEGER NOT NULL DEFAULT 0,
                current_version_id  INTEGER REFERENCES job_definition_version(id),
                source              TEXT NOT NULL DEFAULT 'user',
                deleted_at          DATETIME,
                created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE UNIQUE INDEX idx_job_definition_unique_name_in_parent \
             ON job_definition(parent_id, name) WHERE deleted_at IS NULL",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE UNIQUE INDEX idx_job_definition_unique_root_name \
             ON job_definition(name) WHERE parent_id IS NULL AND deleted_at IS NULL",
        )
        .execute(pool)
        .await?;
        sqlx::query("CREATE INDEX idx_job_definition_root_id ON job_definition(root_id)")
            .execute(pool)
            .await?;
        sqlx::query("CREATE INDEX idx_job_definition_parent_id ON job_definition(parent_id)")
            .execute(pool)
            .await?;

        sqlx::query(
            r#"
            CREATE TABLE job_definition_version (
                id                          INTEGER PRIMARY KEY AUTOINCREMENT,
                definition_id               INTEGER NOT NULL REFERENCES job_definition(id),
                parent_version_id           INTEGER REFERENCES job_definition_version(id),
                content_hash                TEXT NOT NULL,
                kind                        TEXT NOT NULL,
                mode                        TEXT,
                params                      TEXT NOT NULL,
                input_ref                   TEXT,
                description                 TEXT,
                message                     TEXT,
                created_by                  TEXT NOT NULL DEFAULT 'user',
                triggered_by_execution_id   INTEGER REFERENCES job_execution(id),
                created_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (definition_id, content_hash)
            )
            "#,
        )
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE INDEX idx_job_definition_version_def_created \
             ON job_definition_version(definition_id, created_at)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX idx_job_definition_version_hash \
             ON job_definition_version(content_hash)",
        )
        .execute(pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE job_execution (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                definition_version_id    INTEGER NOT NULL REFERENCES job_definition_version(id),
                parent_id                INTEGER REFERENCES job_execution(id),
                root_id                  INTEGER NOT NULL REFERENCES job_execution(id),
                status                   TEXT NOT NULL DEFAULT 'pending',
                plan                     TEXT,
                ledger                   TEXT,
                cancellation_requested   INTEGER NOT NULL DEFAULT 0,
                started_at               DATETIME,
                finished_at              DATETIME,
                error                    TEXT,
                created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE INDEX idx_job_execution_root_status ON job_execution(root_id, status)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX idx_job_execution_status_started ON job_execution(status, started_at)",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX idx_job_execution_version_started \
             ON job_execution(definition_version_id, started_at)",
        )
        .execute(pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE collection_v2 (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id    INTEGER NOT NULL UNIQUE REFERENCES job_execution(id),
                definition_id   INTEGER NOT NULL REFERENCES job_definition(id),
                name            TEXT NOT NULL,
                schema          TEXT,
                created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX idx_collection_v2_def_created ON collection_v2(definition_id, created_at)",
        )
        .execute(pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE collection_item_v2 (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id   INTEGER NOT NULL REFERENCES collection_v2(id),
                item_index      INTEGER NOT NULL,
                status          TEXT NOT NULL DEFAULT 'pending',
                attempt         INTEGER NOT NULL DEFAULT 0,
                data            TEXT,
                error           TEXT,
                backend         TEXT,
                input_tokens    INTEGER,
                output_tokens   INTEGER,
                cached_tokens   INTEGER,
                latency_ms      INTEGER,
                started_at      DATETIME,
                finished_at     DATETIME,
                created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (collection_id, item_index)
            )
            "#,
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "CREATE INDEX idx_collection_item_v2_collection_status \
             ON collection_item_v2(collection_id, status)",
        )
        .execute(pool)
        .await?;

        Ok(())
    })
}
