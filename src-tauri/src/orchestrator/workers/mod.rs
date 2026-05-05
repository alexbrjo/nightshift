//! Worker trait + per-kind implementations. v1 ships an `InferenceWorker`
//! only; group / analysis / js_action workers land in later checkpoints.

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::Client;
use tauri::{AppHandle, Emitter};

use crate::database::DatabaseState;

use super::definition_service::JobDefinitionVersion;
use super::dispatcher::Dispatcher;
use super::execution::JobExecution;

pub mod group;
pub mod inference;
pub mod js_action;

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("cancelled")]
    Cancelled,
    #[error("not implemented for kind={0}")]
    NotImplemented(String),
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),
    #[error("execution failed: {0}")]
    Failed(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

impl From<WorkerError> for String {
    fn from(e: WorkerError) -> Self {
        e.to_string()
    }
}

/// Shared context handed to every worker invocation. Holds the live DB pool
/// (via `DatabaseState` so it tracks project reconnects), the project root
/// path, the HTTP client for LLM calls, the Tauri AppHandle for emitting
/// progress events, and the dispatcher itself so group workers can recurse.
#[derive(Clone)]
pub struct WorkerContext {
    pub db: DatabaseState,
    pub project_root: PathBuf,
    pub http: Client,
    pub app: AppHandle,
    pub dispatcher: Dispatcher,
}

impl WorkerContext {
    pub fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        if let Err(e) = self.app.emit(event, payload) {
            tracing::warn!(event = event, error = %e, "failed to emit event");
        }
    }
}

/// Workers receive an immutable view of the execution row and its pinned
/// version content; they communicate progress through `ctx.emit` and persist
/// state by writing collection_item_v2 rows.
#[allow(dead_code)]
pub trait Worker: Send + Sync {
    fn execute<'a>(
        &'a self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), WorkerError>> + Send + 'a>,
    >;
}

/// Keeps `Arc<dyn Worker>` ergonomic for the dispatcher.
#[allow(dead_code)]
pub type DynWorker = Arc<dyn Worker>;
