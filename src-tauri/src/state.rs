use crate::job_executor::JobExecutor;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::sync::Mutex as TokioMutex;

/// Application state tracking the currently opened folder
pub struct AppState {
    pub root_path: Mutex<Option<PathBuf>>,
}

/// Manages background job execution for inference tasks
pub struct JobManager {
    pub executor: TokioMutex<Option<JobExecutor>>,
}
