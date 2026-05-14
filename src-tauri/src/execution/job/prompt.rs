use minijinja::{Environment, UndefinedBehavior, Value as MjValue};
use tracing::debug;

pub(super) fn render_prompt(template: &str, sample: &serde_json::Value) -> Result<String, String> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Strict);

    let obj = sample.as_object().ok_or_else(|| {
        "Sample must be a JSON object (template variables come from its fields)".to_string()
    })?;
    let mut ctx_map: std::collections::HashMap<String, MjValue> = std::collections::HashMap::new();
    for (k, v) in obj {
        ctx_map.insert(k.clone(), MjValue::from_serialize(v));
    }

    debug!(
        "Template content (first 300 chars): {}",
        &template.chars().take(300).collect::<String>()
    );
    debug!("Sample data: {:?}", sample);

    env.add_template("prompt", template)
        .map_err(|e| format!("Failed to parse template: {:#}", e))?;

    let rendered = env
        .get_template("prompt")
        .map_err(|e| format!("Failed to load template: {:#}", e))?
        .render(MjValue::from_serialize(&ctx_map))
        .map_err(|e| format!("Failed to render template: {:#}", e))?;

    debug!(
        "Rendered prompt (first 500 chars): {}",
        &rendered.chars().take(500).collect::<String>()
    );
    Ok(rendered)
}
