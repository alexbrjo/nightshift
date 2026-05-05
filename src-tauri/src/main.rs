#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod database;
mod migrations;
mod orchestrator;
mod state;
mod utils;

use tauri::Manager;

use crate::commands::*;
use crate::database::DatabaseState;
use crate::orchestrator::OrchestratorState;
use crate::state::AppState;

fn main() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { root_path: std::sync::Mutex::new(None) })
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
                        app.manage(OrchestratorState::new(db_state.clone()));
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
            // Persistence (UI state)
            save_last_folder,
            load_last_folder,
            save_expanded_state,
            load_expanded_state,
            // File-listing dropdowns for the experiment designer
            list_prompt_files,
            list_data_files,
            list_schema_files,
            // Orchestrator: definition CRUD
            definition_create,
            definition_save_version,
            definition_read_current,
            definition_read_version,
            definition_list_versions,
            definition_rename,
            definition_move,
            definition_delete,
            definition_list_roots,
            definition_list_by_root,
            // Orchestrator: experiment lifecycle + execution reads
            experiment_start,
            experiment_cancel,
            execution_get,
            execution_get_tree,
            execution_list_for_definition,
            execution_get_collection,
            execution_get_ledger,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nightshift");
}
