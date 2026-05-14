pub mod agent;
pub mod database;
pub mod file_ops;
pub mod inference;
pub mod methods;
pub mod persistence;

// Re-export all Tauri commands for easy registration
pub use agent::*;
pub use database::*;
pub use file_ops::*;
pub use inference::*;
pub use methods::*;
pub use persistence::*;

pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
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
        save_last_folder,
        load_last_folder,
        save_expanded_state,
        load_expanded_state,
        load_project_layout,
        save_project_layout,
        load_project_conversations,
        save_project_conversations,
        create_inference_job,
        create_transform_job,
        get_inference_job,
        get_job_failures,
        list_inference_jobs,
        update_inference_job,
        delete_inference_job,
        start_inference_job,
        cancel_inference_job,
        subscribe_to_job_status,
        export_job_to_yaml,
        list_prompt_files,
        list_data_files,
        list_schema_files,
        list_transform_scripts,
        check_transform_runtime,
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
        create_method_file,
        get_method_file,
        save_method_file,
        check_method_completeness,
        check_method_document_completeness,
        execute_method_file,
        list_method_executions,
        get_execution_method,
        get_method_execution_nodes,
        get_method_execution_events,
        get_method_execution_artifacts,
        get_execution_files,
        get_execution_log,
        get_execution_node_outputs,
        read_method_artifact,
        pause_method_execution,
        resume_method_execution,
        cancel_method_execution,
    ]
}
