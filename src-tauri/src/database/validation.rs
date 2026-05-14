use super::{InferenceJobInput, TransformJobInput};

pub(super) fn validate_inference_job_input(input: &InferenceJobInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Job name cannot be empty".to_string());
    }

    if input.samples <= 0 {
        return Err("Number of samples must be greater than 0".to_string());
    }

    if url::Url::parse(&input.server_url).is_err() {
        return Err(format!("Invalid server URL: {}", input.server_url));
    }

    Ok(())
}

pub(super) fn validate_transform_job_input(input: &TransformJobInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Job name cannot be empty".to_string());
    }
    if input.data_source.trim().is_empty() {
        return Err("Data source is required".to_string());
    }
    if input.script_file.trim().is_empty() {
        return Err("Transform script file is required".to_string());
    }
    match input.error_mode.as_str() {
        "stop" | "skip" => Ok(()),
        other => Err(format!("Unknown transform error mode: {}", other)),
    }?;
    match input.output_mode.as_str() {
        "one_to_one" | "unwrap_arrays" => Ok(()),
        other => Err(format!("Unknown transform output mode: {}", other)),
    }
}
