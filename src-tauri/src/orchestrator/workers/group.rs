//! `GroupWorker` — coordinates child execution rows. At start it materializes
//! one `job_execution` row per non-deleted child definition (each pinned to
//! that child's current HEAD version), then drives them in order. Sequential
//! is the only walk implemented in v1; `mode='parallel'` is a structural
//! marker that real concurrency will respect later.

use std::pin::Pin;

use serde::Serialize;
use tracing::{info, warn};

use crate::orchestrator::definition_service::JobDefinitionVersion;
use crate::orchestrator::execution::{ExecutionService, JobExecution};

use super::{Worker, WorkerContext, WorkerError};

#[derive(Debug, Clone, Serialize)]
struct ExecutionStatusPayload {
    #[serde(rename = "execId")]
    exec_id: i64,
    status: &'static str,
    #[serde(rename = "parentId")]
    parent_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
pub struct GroupWorker;

impl GroupWorker {
    pub fn new() -> Self {
        Self
    }

    async fn execute_inner(
        &self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> Result<(), WorkerError> {
        if version.kind != "group" {
            return Err(WorkerError::InvalidConfig(format!(
                "GroupWorker invoked for kind={}",
                version.kind
            )));
        }

        let exec_svc = ExecutionService::new(ctx.db.clone());
        exec_svc.mark_running(exec.id).await?;
        ctx.emit(
            "execution-status",
            ExecutionStatusPayload {
                exec_id: exec.id,
                status: "running",
                parent_id: exec.parent_id,
                error: None,
            },
        );

        // Find children of this group definition. Order by `position` so the
        // sequential walk matches the user's intent.
        let pool = ctx.db.pool();
        let children: Vec<(i64, Option<i64>)> = sqlx::query_as(
            "SELECT id, current_version_id FROM job_definition \
             WHERE parent_id = ? AND deleted_at IS NULL \
             ORDER BY position ASC, id ASC",
        )
        .bind(version.definition_id)
        .fetch_all(&pool)
        .await?;

        if children.is_empty() {
            warn!(exec_id = exec.id, "group has no children — completing immediately");
            exec_svc.mark_completed(exec.id).await?;
            ctx.emit(
                "execution-status",
                ExecutionStatusPayload {
                    exec_id: exec.id,
                    status: "completed",
                    parent_id: exec.parent_id,
                    error: None,
                },
            );
            return Ok(());
        }

        // Materialize child execution rows. Pre-flight: every child must have
        // a saved version. We rely on `ensure_all_versions_saved` at experiment
        // start, but check defensively in case the planner created a child
        // without saving (shouldn't happen in P0).
        let mut child_exec_ids: Vec<i64> = Vec::with_capacity(children.len());
        for (def_id, version_id_opt) in &children {
            let Some(version_id) = version_id_opt else {
                let msg = format!("child definition {} has no saved version", def_id);
                exec_svc.mark_failed(exec.id, &msg).await?;
                return Err(WorkerError::Failed(msg));
            };
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO job_execution \
                    (definition_version_id, parent_id, root_id, status) \
                 VALUES (?, ?, ?, 'pending') RETURNING id",
            )
            .bind(version_id)
            .bind(exec.id)
            .bind(exec.root_id)
            .fetch_one(&pool)
            .await?;
            child_exec_ids.push(id);
        }

        info!(exec_id = exec.id, n = child_exec_ids.len(), "GroupWorker dispatching children");

        // Sequential walk: each child runs to completion before the next.
        // Failure of any child fails the group; cancellation propagates.
        for child_exec_id in child_exec_ids {
            if exec_svc.is_cancellation_requested(exec.root_id).await? {
                exec_svc.mark_cancelled(exec.id).await?;
                ctx.emit(
                    "execution-status",
                    ExecutionStatusPayload {
                        exec_id: exec.id,
                        status: "cancelled",
                        parent_id: exec.parent_id,
                        error: None,
                    },
                );
                return Err(WorkerError::Cancelled);
            }

            // Pull the (just-inserted) child execution row + version, then
            // dispatch it through the same dispatcher used at the root.
            let child_exec = exec_svc
                .get(child_exec_id)
                .await?
                .ok_or_else(|| WorkerError::Failed("child exec missing".into()))?;
            let defs = crate::orchestrator::definition_service::DefinitionService::new(
                ctx.db.clone(),
            );
            let result =
                ctx.dispatcher.dispatch(child_exec, std::sync::Arc::new(defs), ctx.clone()).await;

            match result {
                Ok(()) => continue,
                Err(WorkerError::Cancelled) => {
                    exec_svc.mark_cancelled(exec.id).await?;
                    return Err(WorkerError::Cancelled);
                }
                Err(e) => {
                    let msg = format!("child {} failed: {}", child_exec_id, e);
                    exec_svc.mark_failed(exec.id, &msg).await?;
                    ctx.emit(
                        "execution-status",
                        ExecutionStatusPayload {
                            exec_id: exec.id,
                            status: "failed",
                            parent_id: exec.parent_id,
                            error: Some(msg.clone()),
                        },
                    );
                    return Err(WorkerError::Failed(msg));
                }
            }
        }

        exec_svc.mark_completed(exec.id).await?;
        ctx.emit(
            "execution-status",
            ExecutionStatusPayload {
                exec_id: exec.id,
                status: "completed",
                parent_id: exec.parent_id,
                error: None,
            },
        );
        Ok(())
    }
}

impl Worker for GroupWorker {
    fn execute<'a>(
        &'a self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), WorkerError>> + Send + 'a>> {
        Box::pin(self.execute_inner(exec, version, ctx))
    }
}
