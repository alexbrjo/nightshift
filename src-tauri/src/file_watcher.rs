use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use tracing::{debug, info};

pub struct FileWatcher {
    watcher: Option<RecommendedWatcher>,
}

impl FileWatcher {
    pub fn new() -> Self {
        Self {
            watcher: None,
        }
    }

    pub fn start(
        &mut self,
        path: PathBuf,
    ) -> Result<(), notify::Error> {
        let _watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    debug!("File system event: {:?}", event);
                }
            },
            Config::default(),
        )?;

        self.watcher = Some(_watcher);

        info!("Started watching directory: {:?}", path);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.watcher = None;
        info!("Stopped file watcher");
    }
}

impl Default for FileWatcher {
    fn default() -> Self {
        Self::new()
    }
}

pub struct JsonSchemaValidator;

impl JsonSchemaValidator {
    pub fn validate(data: &serde_json::Value, schema: &str) -> Result<bool, jsonschema::ValidationError> {
        let schema_obj = serde_json::from_str(schema)
            .map_err(|e| jsonschema::ValidationError::custom(
                "Invalid schema",
                &serde_json::json!({}),
                &serde_json::json!({}),
                e.to_string(),
            ))?;

        let compiled = jsonschema::JSONSchema::compile(&schema_obj)
            .map_err(|e| jsonschema::ValidationError::custom(
                "Failed to compile schema",
                &serde_json::json!({}),
                &serde_json::json!({}),
                e.to_string(),
            ))?;

        let result = compiled.validate(data);
        
        if result.is_valid() {
            Ok(true)
        } else {
            Err(result.into_iter().next().unwrap())
        }
    }

    pub fn extract_schema_from_data(data: &[serde_json::Value]) -> serde_json::Value {
        if data.is_empty() {
            return serde_json::json!({ "type": "object", "properties": {} });
        }

        let mut properties = serde_json::Map::new();
        let mut required = Vec::new();

        for item in data {
            if let Some(obj) = item.as_object() {
                for (key, value) in obj {
                    let schema_type = match value {
                        serde_json::Value::Null => "null",
                        serde_json::Value::Bool(_) => "boolean",
                        serde_json::Value::Number(_) => "number",
                        serde_json::Value::String(_) => "string",
                        serde_json::Value::Array(_) => "array",
                        serde_json::Value::Object(_) => "object",
                    };

                    properties.entry(key.clone()).or_insert_with(|| {
                        serde_json::json!({ "type": schema_type })
                    });

                    if !value.is_null() && !required.contains(key) {
                        required.push(key.clone());
                    }
                }
            }
        }

        serde_json::json!({
            "type": "object",
            "properties": properties,
            "required": required
        })
    }
}
