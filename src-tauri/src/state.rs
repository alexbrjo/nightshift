use std::path::PathBuf;
use std::sync::Mutex;

/// Application state tracking the currently opened folder. Run-state for
/// experiments lives in `OrchestratorState` (declared in `orchestrator/mod.rs`).
pub struct AppState {
    pub root_path: Mutex<Option<PathBuf>>,
}
