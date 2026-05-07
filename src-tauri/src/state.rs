use crate::job_executor::JobExecutor;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
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

#[derive(Clone)]
pub struct MethodExecutionControl {
    pub pause_requested: Arc<AtomicBool>,
    pub cancel_requested: Arc<AtomicBool>,
}

impl MethodExecutionControl {
    pub fn new() -> Self {
        Self {
            pause_requested: Arc::new(AtomicBool::new(false)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub struct MethodExecutionManager {
    pub controls: Arc<TokioMutex<HashMap<i64, MethodExecutionControl>>>,
}
