//! Orchestrator module — definition CRUD with content-addressed versioning,
//! plus dispatcher / resolver / workers for running experiments.
//!
//! `OrchestratorState` is a Tauri-managed singleton holding the services
//! shared across command handlers. Each Tauri command reaches them via
//! `tauri::State<OrchestratorState>` and through them to the live `SqlitePool`
//! (which `DatabaseState` may hot-swap when the user opens a different
//! project).

pub mod definition_service;
pub mod dispatcher;
pub mod execution;
pub mod llm;
pub mod resolver;
pub mod workers;

use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use tauri::{AppHandle, Emitter};

use crate::database::DatabaseState;
pub use definition_service::DefinitionService;

use dispatcher::Dispatcher;
use execution::ExecutionService;
use workers::WorkerContext;

#[derive(Clone)]
pub struct OrchestratorState {
    pub definition_service: Arc<DefinitionService>,
    pub execution_service: ExecutionService,
    pub dispatcher: Dispatcher,
    pub http: Client,
}

impl OrchestratorState {
    pub fn new(db: DatabaseState) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP client builds with default settings");
        Self {
            definition_service: Arc::new(DefinitionService::new(db.clone())),
            execution_service: ExecutionService::new(db),
            dispatcher: Dispatcher::new(),
            http,
        }
    }

    /// Begin a run for the given root definition. v1 single-leaf path: pins
    /// the root definition's HEAD version, creates one root `job_execution`,
    /// and spawns a task that dispatches it to the appropriate worker. Group
    /// + analysis + planner integration land in later checkpoints.
    pub async fn start_run(
        &self,
        root_def_id: i64,
        app: AppHandle,
    ) -> Result<i64, String> {
        self.definition_service
            .ensure_all_versions_saved(root_def_id)
            .await
            .map_err(|e| e.to_string())?;
        let dv = self.definition_service.read_current(root_def_id).await.map_err(|e| e.to_string())?;
        let version_id = dv
            .version
            .as_ref()
            .map(|v| v.id)
            .ok_or_else(|| "definition has no current version".to_string())?;

        let exec_id = self
            .execution_service
            .create_root_execution(version_id)
            .await
            .map_err(|e| format!("failed to create execution: {}", e))?;

        let db = self.execution_service.db.clone();
        let ctx = WorkerContext {
            project_root: db.get_project_root(),
            db,
            http: self.http.clone(),
            app: app.clone(),
            dispatcher: self.dispatcher.clone(),
        };

        let _ = app.emit(
            "experiment-started",
            serde_json::json!({"rootExecId": exec_id, "rootDefId": root_def_id}),
        );

        let dispatcher = self.dispatcher.clone();
        let defs = self.definition_service.clone();
        let execs = self.execution_service.clone();
        tokio::spawn(async move {
            dispatcher.run_to_completion(exec_id, defs, execs, ctx).await;
        });

        Ok(exec_id)
    }

    pub async fn cancel_run(&self, root_exec_id: i64) -> Result<(), String> {
        self.execution_service
            .request_cancel(root_exec_id)
            .await
            .map_err(|e| format!("failed to request cancel: {}", e))
    }
}
