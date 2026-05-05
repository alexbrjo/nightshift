//! Orchestrator module — definition CRUD with content-addressed versioning,
//! plus (in later commits) planner, dispatcher, resolver, and workers.
//!
//! The orchestrator owns its `DefinitionService` as a singleton. Each Tauri
//! command reaches the service via `tauri::State<OrchestratorState>` and
//! through it to the live `SqlitePool` (which `DatabaseState` may hot-swap
//! when the user opens a different project).

pub mod definition_service;

use std::sync::Arc;

use crate::database::DatabaseState;
pub use definition_service::DefinitionService;

#[derive(Clone)]
pub struct OrchestratorState {
    pub definition_service: Arc<DefinitionService>,
}

impl OrchestratorState {
    pub fn new(db: DatabaseState) -> Self {
        Self { definition_service: Arc::new(DefinitionService::new(db)) }
    }
}
