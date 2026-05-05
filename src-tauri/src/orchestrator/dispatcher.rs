//! Dispatcher — picks the worker for a given execution row's kind and
//! drives it to completion. v1 only knows about `kind=inference`; group /
//! analysis / js_action workers register here in later checkpoints.

use std::sync::Arc;

use tracing::{error, info};

use crate::orchestrator::definition_service::DefinitionService;
use crate::orchestrator::execution::{ExecutionService, JobExecution};
use crate::orchestrator::workers::inference::InferenceWorker;
use crate::orchestrator::workers::{Worker, WorkerContext, WorkerError};

#[derive(Clone)]
pub struct Dispatcher {
    inference: Arc<InferenceWorker>,
}

impl Dispatcher {
    pub fn new() -> Self {
        Self { inference: Arc::new(InferenceWorker::new()) }
    }

    /// Run the given execution row to terminal status. The version is loaded
    /// fresh from the DB so the worker always sees pinned content even if the
    /// definition has new HEADs.
    pub async fn dispatch(
        &self,
        exec: JobExecution,
        defs: Arc<DefinitionService>,
        ctx: WorkerContext,
    ) -> Result<(), WorkerError> {
        let version = defs
            .read_version(exec.definition_version_id)
            .await
            .map_err(|e| WorkerError::Failed(format!("failed to load version: {}", e)))?;

        match version.kind.as_str() {
            "inference" => self.inference.execute(exec, version, ctx).await,
            other => Err(WorkerError::NotImplemented(other.to_string())),
        }
    }

    /// Run the root execution; bookkeeping for failures lives here so callers
    /// don't need to track them. The execution row's status is updated by
    /// each worker; this wraps the dispatch so a hard error still flows back
    /// into a `failed` row + emitted event.
    pub async fn run_to_completion(
        &self,
        exec_id: i64,
        defs: Arc<DefinitionService>,
        execs: ExecutionService,
        ctx: WorkerContext,
    ) {
        let exec = match execs.get(exec_id).await {
            Ok(Some(row)) => row,
            Ok(None) => {
                error!(exec_id, "execution row vanished before dispatch");
                return;
            }
            Err(e) => {
                error!(exec_id, error = %e, "failed to fetch execution row");
                return;
            }
        };

        info!(exec_id, kind_via_version_id = exec.definition_version_id, "dispatching execution");
        let parent_id = exec.parent_id;
        let result = self.dispatch(exec, defs, ctx.clone()).await;

        match &result {
            Ok(()) => {
                if let Err(e) = ctx.app.emit_completed(exec_id, parent_id) {
                    tracing::warn!(error = %e, "emit experiment-completed failed");
                }
            }
            Err(WorkerError::Cancelled) => {
                if let Err(e) = ctx.app.emit_cancelled(exec_id) {
                    tracing::warn!(error = %e, "emit experiment-cancelled failed");
                }
            }
            Err(e) => {
                let _ = execs.mark_failed(exec_id, &e.to_string()).await;
                if let Err(e) = ctx.app.emit_failed(exec_id, &e.to_string()) {
                    tracing::warn!(error = %e, "emit experiment-failed failed");
                }
            }
        }
    }
}

/// Tiny convenience trait so dispatcher emits don't have to wire payload
/// types inline. Kept private to this module.
trait AppHandleEmits {
    fn emit_completed(&self, root_exec_id: i64, parent: Option<i64>) -> tauri::Result<()>;
    fn emit_failed(&self, root_exec_id: i64, error: &str) -> tauri::Result<()>;
    fn emit_cancelled(&self, root_exec_id: i64) -> tauri::Result<()>;
}

impl AppHandleEmits for tauri::AppHandle {
    fn emit_completed(&self, root_exec_id: i64, _parent: Option<i64>) -> tauri::Result<()> {
        use tauri::Emitter;
        self.emit("experiment-completed", serde_json::json!({"rootExecId": root_exec_id}))
    }
    fn emit_failed(&self, root_exec_id: i64, error: &str) -> tauri::Result<()> {
        use tauri::Emitter;
        self.emit(
            "experiment-failed",
            serde_json::json!({"rootExecId": root_exec_id, "error": error}),
        )
    }
    fn emit_cancelled(&self, root_exec_id: i64) -> tauri::Result<()> {
        use tauri::Emitter;
        self.emit("experiment-cancelled", serde_json::json!({"rootExecId": root_exec_id}))
    }
}
