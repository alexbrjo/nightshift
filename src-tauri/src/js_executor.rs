use crate::db::{AppState, Result};
use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct JsActionConfig {
    pub name: String,
    pub script_path: Option<String>,
    pub inline_script: Option<String>,
    pub input_files: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct JsActionResult {
    pub results: Vec<serde_json::Value>,
    pub processed_count: usize,
    pub error_count: usize,
}

pub async fn run_js_action(
    state: &AppState,
    config: JsActionConfig,
) -> Result<JsActionResult> {
    // Get the script content
    let script = if let Some(path) = &config.script_path {
        load_file(state, path).await?
    } else if let Some(inline) = &config.inline_script {
        inline.clone()
    } else {
        return Err(crate::db::DbError::JobNotFound("No script provided".to_string()));
    };

    // Load input data
    let inputs = crate::inference::load_input_files(state, &config.input_files.unwrap_or_default()).await?;

    // Create isolated JS runtime
    let rt = Runtime::new()?;
    rt.set_max_stack_size(512 * 1024); // 512KB stack limit
    
    let ctx = Context::full(&rt)?;
    
    let mut results = Vec::new();
    let mut error_count = 0;

    ctx.with(|ctx| {
        // Execute the script to get the transform function
        let full_script = format!(
            r#"
            {}
            
            if (typeof transform === 'function') {{
                transform;
            }} else {{
                throw new Error('Script must export a transform function');
            }}
            "#,
            script
        );

        let transform_func: Function = ctx.eval(full_script.as_str())?;

        for (index, input) in inputs.iter().enumerate() {
            let json_str = serde_json::to_string(input).unwrap_or_default();
            
            let js_value = ctx.eval::<rquickjs::Value, _>(format!("JSON.parse('{}')", json_str).as_str());
            
            match js_value.and_then(|v| transform_func.call((v, index))) {
                Ok(result) => {
                    if let Ok(json) = ctx.json_stringify(result) {
                        if let Some(s) = json {
                            if let Ok(val) = serde_json::from_str(&s.to_string().unwrap_or_default()) {
                                results.push(val);
                                continue;
                            }
                        }
                    }
                    error_count += 1;
                }
                Err(e) => {
                    error_count += 1;
                    results.push(serde_json::json!({ 
                        "error": e.to_string(),
                        "input": input 
                    }));
                }
            }
        }

        Ok::<_, rquickjs::Error>(())
    })?;

    Ok(JsActionResult {
        results,
        processed_count: inputs.len() - error_count,
        error_count,
    })
}

async fn load_file(state: &AppState, path: &str) -> Result<String> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| crate::db::DbError::ProjectNotFound("No project".to_string()))?;
    
    let full_path = std::path::PathBuf::from(project_path).join(path);
    Ok(tokio::fs::read_to_string(&full_path).await?)
}
