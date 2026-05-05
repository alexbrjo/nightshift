//! Row types for `job_execution` / `collection_v2` / `collection_item_v2`,
//! plus a thin `ExecutionService` for status transitions, cancellation
//! polling, and event emission.

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::database::DatabaseState;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobExecution {
    pub id: i64,
    pub definition_version_id: i64,
    pub parent_id: Option<i64>,
    pub root_id: i64,
    pub status: String,
    pub plan: Option<String>,
    pub ledger: Option<String>,
    pub cancellation_requested: i64,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionCollection {
    pub id: i64,
    pub execution_id: i64,
    pub definition_id: i64,
    pub name: String,
    pub schema: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionCollectionItem {
    pub id: i64,
    pub collection_id: i64,
    pub item_index: i64,
    pub status: String,
    pub attempt: i64,
    pub data: Option<String>,
    pub error: Option<String>,
    pub backend: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub latency_ms: Option<i64>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct ExecutionService {
    pub(crate) db: DatabaseState,
}

impl ExecutionService {
    pub fn new(db: DatabaseState) -> Self {
        Self { db }
    }

    /// Create the root execution row pinned to `definition_version_id`.
    /// `root_id` is set to the row's own id post-insert.
    pub async fn create_root_execution(
        &self,
        definition_version_id: i64,
    ) -> Result<i64, sqlx::Error> {
        let pool = self.db.pool();
        let mut tx = pool.begin().await?;
        let res = sqlx::query(
            "INSERT INTO job_execution (definition_version_id, root_id, status) \
             VALUES (?, 0, 'pending')",
        )
        .bind(definition_version_id)
        .execute(&mut *tx)
        .await?;
        let id = res.last_insert_rowid();
        sqlx::query("UPDATE job_execution SET root_id = id WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn get(&self, exec_id: i64) -> Result<Option<JobExecution>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM job_execution WHERE id = ?")
            .bind(exec_id)
            .fetch_optional(&self.db.pool())
            .await
    }

    pub async fn get_tree(&self, root_exec_id: i64) -> Result<Vec<JobExecution>, sqlx::Error> {
        sqlx::query_as(
            "SELECT * FROM job_execution WHERE root_id = ? ORDER BY parent_id ASC NULLS FIRST, id ASC",
        )
        .bind(root_exec_id)
        .fetch_all(&self.db.pool())
        .await
    }

    pub async fn mark_running(&self, exec_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE job_execution SET status = 'running', started_at = CURRENT_TIMESTAMP \
             WHERE id = ?",
        )
        .bind(exec_id)
        .execute(&self.db.pool())
        .await?;
        Ok(())
    }

    pub async fn mark_completed(&self, exec_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE job_execution SET status = 'completed', finished_at = CURRENT_TIMESTAMP \
             WHERE id = ?",
        )
        .bind(exec_id)
        .execute(&self.db.pool())
        .await?;
        Ok(())
    }

    pub async fn mark_failed(&self, exec_id: i64, error: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE job_execution SET status = 'failed', finished_at = CURRENT_TIMESTAMP, \
             error = ? WHERE id = ?",
        )
        .bind(error)
        .bind(exec_id)
        .execute(&self.db.pool())
        .await?;
        Ok(())
    }

    pub async fn mark_cancelled(&self, exec_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE job_execution SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP \
             WHERE id = ? AND status NOT IN ('completed', 'failed')",
        )
        .bind(exec_id)
        .execute(&self.db.pool())
        .await?;
        Ok(())
    }

    /// Set the cancellation flag. Workers poll this between iterations and
    /// abort the run on the next check; rows already completed are preserved.
    pub async fn request_cancel(&self, root_exec_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE job_execution SET cancellation_requested = 1 WHERE root_id = ?",
        )
        .bind(root_exec_id)
        .execute(&self.db.pool())
        .await?;
        Ok(())
    }

    pub async fn is_cancellation_requested(&self, exec_id: i64) -> Result<bool, sqlx::Error> {
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT cancellation_requested FROM job_execution WHERE id = ?")
                .bind(exec_id)
                .fetch_optional(&self.db.pool())
                .await?;
        Ok(matches!(row, Some((1,))))
    }
}
