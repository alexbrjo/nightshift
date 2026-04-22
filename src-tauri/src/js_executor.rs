use crate::db::{AppState, Result};
use rquickjs::{Context, Function, JsLifetime, Runtime};
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
        // Expected export: function transform(item, index, allItems) { return transformedItem; }
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

        let transform_func: Function = ctx.eval(&full_script)?;

        for (index, input) in inputs.iter().enumerate() {
            match transform_func.call((input.clone(), index, &inputs)) {
                Ok(result) => {
                    // Convert JS value to serde_json::Value
                    let json_result = rquickjs::function::Rest::from_js(&ctx, result.into_value())
                        .map(|r| r.0.first().cloned())
                        .and_then(|v| v.map(|val| val_to_json(&ctx, val)))
                        .unwrap_or_else(|| Ok(serde_json::json!({ "error": "Failed to convert result" })));
                    
                    match json_result {
                        Ok(val) => results.push(val),
                        Err(_) => error_count += 1,
                    }
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

fn val_to_json(ctx: &rquickjs::CtxCtx<'_, '_>, val: rquickjs::Value) -> serde_json::Value {
    if val.is_null() {
        serde_json::Value::Null
    } else if val.is_undefined() {
        serde_json::Value::Null
    } else if let Some(bool_val) = val.as_bool() {
        serde_json::json!(bool_val)
    } else if let Some(int_val) = val.as_int() {
        serde_json::json!(int_val)
    } else if let Some(float_val) = val.as_float() {
        serde_json::json!(float_val)
    } else if let Some(str_val) = val.as_string() {
        serde_json::json!(str_val.to_string().unwrap_or_default())
    } else if let Some(arr) = val.as_array() {
        let mut vec = Vec::new();
        for item in arr.iter::<rquickjs::Value>() {
            if let Ok(item_val) = item {
                vec.push(val_to_json(ctx, item_val));
            }
        }
        serde_json::json!(vec)
    } else if let Some(obj) = val.as_object() {
        let mut map = serde_json::Map::new();
        for key_res in obj.keys::<String>() {
            if let Ok(key) = key_res {
                if let Ok(val) = obj.get(&key) {
                    map.insert(key, val_to_json(ctx, val));
                }
            }
        }
        serde_json::json!(map)
    } else {
        serde_json::Value::Null
    }
}
