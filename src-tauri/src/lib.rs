#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod inference;
mod js_executor;
mod pipeline;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "nightshift=debug,info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::read_file,
            commands::write_file,
            commands::delete_file,
            commands::list_directory,
            commands::watch_files,
            commands::run_inference_job,
            commands::run_js_action,
            commands::create_collection,
            commands::get_collection_items,
            commands::export_collection,
            commands::save_pipeline,
            commands::run_pipeline_trial,
            commands::run_pipeline,
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}
