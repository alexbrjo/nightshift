#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod codex_app_server;
mod commands;
mod database;
mod job_executor;
mod methods;
mod sampling;
mod state;
mod transform_runner;
mod utils;

use tauri::Manager;

use crate::codex_app_server::CodexAppServerManager;
use crate::commands::*;
use crate::database::{
    DatabaseState, add_collection_item, create_collection, create_inference_job,
    create_transform_job, delete_collection_item, delete_inference_job, export_collection_csv,
    export_collection_jsonl, get_collection_count, get_collection_items, get_collections_for_job,
    get_inference_job, get_job_failures, list_all_collections, list_inference_jobs,
    list_selectable_collections, update_inference_job,
};
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
        .invoke_handler(tauri::generate_handler![
            // File operations
            scan_folder,
            set_root_path,
            get_root_path,
            read_file,
            rename_path,
            move_path,
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
            load_project_layout,
            save_project_layout,
            load_project_conversations,
            save_project_conversations,
            // Database commands
            create_inference_job,
            create_transform_job,
            get_inference_job,
            get_job_failures,
            list_inference_jobs,
            update_inference_job,
            delete_inference_job,
            create_collection,
            get_collections_for_job,
            list_all_collections,
            list_selectable_collections,
            add_collection_item,
            get_collection_items,
            get_collection_count,
            delete_collection_item,
            export_collection_jsonl,
            export_collection_csv,
            // Job execution commands
            start_inference_job,
            cancel_inference_job,
            subscribe_to_job_status,
            export_job_to_yaml,
            list_prompt_files,
            list_data_files,
            list_schema_files,
            list_transform_scripts,
            check_transform_runtime,
            // Methods
            start_design_session,
            send_design_chat_message,
            get_design_agent_config,
            get_method_agent_function_tools,
            call_method_agent_function_tool,
            get_current_method_draft,
            create_method_draft,
            update_method_draft_metadata,
            update_method_draft_execution_config,
            replace_method_draft_graph,
            explain_current_method_draft,
            reset_method_draft,
            save_current_method_draft,
            save_method,
            preflight_method,
            list_methods,
            get_method,
            read_method_file,
            execute_current_method_draft,
            execute_method,
            list_method_executions,
            get_method_execution_nodes,
            get_method_execution_events,
            get_method_execution_artifacts,
            read_method_artifact,
            pause_method_execution,
            resume_method_execution,
            cancel_method_execution,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nightshift");
}
