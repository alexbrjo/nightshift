#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod database;
mod job_executor;
mod state;
mod utils;

use tauri::Manager;

use crate::commands::*;
use crate::database::{
    DatabaseState, create_inference_job, get_inference_job, list_inference_jobs,
    update_inference_job, delete_inference_job, create_collection, add_collection_item,
    get_collection_items, get_collection_count,
};
use crate::state::{AppState, JobManager};
use tokio::sync::Mutex as TokioMutex;

fn main() {
    // Initialize tracing subscriber
    tracing_subscriber::fmt::init();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { root_path: std::sync::Mutex::new(None) })
        .manage(JobManager {
            executor: TokioMutex::new(None),
        })
        .setup(|app| {
            // Initialize database connection with project-based path
            // Use current working directory as default project location
            let project_path = std::env::current_dir()
                .expect("Failed to get current working directory");

            // Initialize database connection using tokio runtime
            #[cfg(not(target_os = "android"))]
            {
                let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
                match rt.block_on(DatabaseState::new(&project_path)) {
                    Ok(db_state) => { app.manage(db_state); }
                    Err(e) => {
                        eprintln!("Failed to initialize database for project at {:?}: {}", project_path, e);
                        eprintln!("Make sure the project has a .nightshift directory or create one.");
                        std::process::exit(1);
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // File operations
            scan_folder,
            set_root_path,
            get_root_path,
            read_file,
            rename_path,
            delete_path,
            copy_file,
            write_file,
            create_folder,
            create_file,
            // Persistence
            save_last_folder,
            load_last_folder,
            save_expanded_state,
            load_expanded_state,
            // Database commands
            create_inference_job,
            get_inference_job,
            list_inference_jobs,
            update_inference_job,
            delete_inference_job,
            create_collection,
            add_collection_item,
            get_collection_items,
            get_collection_count,
            // Job execution commands
            start_inference_job,
            cancel_inference_job,
            subscribe_to_job_status,
            export_job_to_yaml,
            list_prompt_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nightshift");
}
