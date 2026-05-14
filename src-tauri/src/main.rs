#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![warn(clippy::cognitive_complexity)]
#![warn(clippy::too_many_arguments)]
#![warn(clippy::too_many_lines)]
#![warn(clippy::type_complexity)]

mod codex_app_server;
mod commands;
mod database;
mod execution;
mod methods;
mod state;
mod utils;

use tauri::Manager;

use crate::codex_app_server::CodexAppServerManager;
use crate::database::DatabaseState;
use crate::state::{AppState, JobManager, MethodExecutionManager};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

fn main() {
    // Initialize tracing subscriber
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { root_path: std::sync::Mutex::new(None) })
        .manage(JobManager { executor: TokioMutex::new(None) })
        .manage(MethodExecutionManager { controls: Arc::new(TokioMutex::new(HashMap::new())) })
        .manage(CodexAppServerManager::new())
        .setup(|app| {
            // The DB starts as an in-memory SQLite scratch pool — no .nightshift
            // directory is created until the user opens a project, at which
            // point `scan_folder`/`set_root_path` calls `reconnect` to swap in
            // the project's persistent file DB.
            #[cfg(not(target_os = "android"))]
            {
                let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
                match rt.block_on(DatabaseState::empty()) {
                    Ok(db_state) => {
                        app.manage(db_state);
                    }
                    Err(e) => {
                        eprintln!("Failed to initialize in-memory database: {}", e);
                        std::process::exit(1);
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(commands::invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running nightshift");
}
