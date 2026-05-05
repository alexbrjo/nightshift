//! Dispatcher — picks the worker for a given execution row's kind and
//! drives it to completion. v1 routes inference, group, and js_action;
//! analysis joins in checkpoint 8.

use std::sync::Arc;

use tracing::{error, info};

use crate::orchestrator::definition_service::DefinitionService;
use crate::orchestrator::execution::{ExecutionService, JobExecution};
use crate::orchestrator::workers::analysis::AnalysisWorker;
use crate::orchestrator::workers::group::GroupWorker;
use crate::orchestrator::workers::inference::InferenceWorker;
use crate::orchestrator::workers::js_action::JsActionWorker;
use crate::orchestrator::workers::{Worker, WorkerContext, WorkerError};

#[derive(Clone, Default)]
pub struct Dispatcher;

impl Dispatcher {
    pub fn new() -> Self {
        Self
    }

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
            "inference" => InferenceWorker::new().execute(exec, version, ctx).await,
            "group" => GroupWorker::new().execute(exec, version, ctx).await,
            "analysis" => AnalysisWorker::new().execute(exec, version, ctx).await,
            "js_action" => JsActionWorker::new().execute(exec, version, ctx).await,
            other => Err(WorkerError::NotImplemented(other.to_string())),
        }
    }

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

        info!(exec_id, "dispatching root execution");
        let result = self.dispatch(exec, defs, ctx.clone()).await;

        match &result {
            Ok(()) => {
                if let Err(e) = ctx.app.emit_completed(exec_id) {
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

trait AppHandleEmits {
    fn emit_completed(&self, root_exec_id: i64) -> tauri::Result<()>;
    fn emit_failed(&self, root_exec_id: i64, error: &str) -> tauri::Result<()>;
    fn emit_cancelled(&self, root_exec_id: i64) -> tauri::Result<()>;
}

impl AppHandleEmits for tauri::AppHandle {
    fn emit_completed(&self, root_exec_id: i64) -> tauri::Result<()> {
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
