//! Shared LLM-call helpers used by `InferenceWorker` (and, eventually,
//! `AnalysisWorker`). Lifted from the legacy `JobExecutor` so worker code
//! doesn't depend on the legacy struct. Both copies coexist until cutover —
//! `job_executor.rs` keeps its own internal versions to avoid touching the
//! production single-job path.

use std::path::Path;

use minijinja::{Environment, UndefinedBehavior, Value as MjValue};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, Duration};
use tracing::{debug, info, warn};
use url::Url;

#[derive(Debug, Serialize)]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
struct LlmResponse {
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

impl ResponseMessage {
    fn extract_content(&self) -> &str {
        let primary = self.content.as_deref().unwrap_or("");
        if !primary.trim().is_empty() {
            return primary;
        }
        self.reasoning_content.as_deref().unwrap_or("")
    }
}

#[derive(Debug, Deserialize, Default)]
struct Usage {
    #[serde(default)]
    prompt_tokens: Option<i32>,
    #[serde(default)]
    completion_tokens: Option<i32>,
    #[serde(default)]
    cached_tokens: Option<i32>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize, Default)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<i32>,
}

#[derive(Debug, Default, Clone)]
pub struct LlmCallOutcome {
    pub content: String,
    pub input_tokens: Option<i32>,
    pub output_tokens: Option<i32>,
    pub cached_tokens: Option<i32>,
    pub latency_ms: Option<i64>,
    pub backend: Option<String>,
}

/// Map the form's thinking-budget integer to OpenAI's `reasoning_effort` enum.
pub fn thinking_budget_to_effort(budget: Option<i32>) -> Option<String> {
    let b = budget?;
    if b <= 0 {
        return None;
    }
    Some(if b <= 750 {
        "low".to_string()
    } else if b <= 1250 {
        "medium".to_string()
    } else {
        "high".to_string()
    })
}

/// Resolve a project-relative path, rejecting absolute paths, `..` components,
/// and any path that escapes the project root after symlink resolution.
pub fn resolve_within_project(
    project_root: &Path,
    user_path: &str,
) -> Result<std::path::PathBuf, String> {
    use std::path::{Component, Path as StdPath};
    let path = StdPath::new(user_path);
    if path.is_absolute() {
        return Err(format!("Absolute paths are not allowed: {}", user_path));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("Path may not contain '..': {}", user_path));
    }

    let root_canonical = std::fs::canonicalize(project_root).map_err(|e| {
        format!("Failed to resolve project root {}: {}", project_root.display(), e)
    })?;
    let full = root_canonical.join(path);
    let full_canonical = std::fs::canonicalize(&full)
        .map_err(|e| format!("Failed to resolve path {}: {}", full.display(), e))?;
    if !full_canonical.starts_with(&root_canonical) {
        return Err(format!("Path escapes project root: {}", user_path));
    }
    Ok(full_canonical)
}

pub async fn load_prompt_file(project_root: &Path, path: &str) -> Result<String, String> {
    let full_path = resolve_within_project(project_root, path)?;
    tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|e| format!("Failed to read prompt file {}: {}", path, e))
}

/// Render Jinja2 prompt with sample data — sample fields exposed at the top
/// level (LangChain convention). Strict undefined surfaces typos as errors.
pub fn render_prompt(template: &str, sample: &serde_json::Value) -> Result<String, String> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    let obj = sample.as_object().ok_or_else(|| {
        "Sample must be a JSON object (template variables come from its fields)".to_string()
    })?;
    let mut ctx_map: std::collections::HashMap<String, MjValue> =
        std::collections::HashMap::new();
    for (k, v) in obj {
        ctx_map.insert(k.clone(), MjValue::from_serialize(v));
    }
    env.add_template("prompt", template)
        .map_err(|e| format!("Failed to parse template: {:#}", e))?;
    let rendered = env
        .get_template("prompt")
        .map_err(|e| format!("Failed to load template: {:#}", e))?
        .render(MjValue::from_serialize(&ctx_map))
        .map_err(|e| format!("Failed to render template: {:#}", e))?;
    Ok(rendered)
}

pub async fn build_response_format(
    project_root: &Path,
    output_mode: &str,
    json_schema_file: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    match output_mode {
        "Plain JSON" => Ok(Some(serde_json::json!({ "type": "json_object" }))),
        "JSON Schema" => {
            let schema_file = json_schema_file.ok_or_else(|| {
                "Output mode is 'JSON Schema' but no schema file was selected".to_string()
            })?;
            let full_path = resolve_within_project(project_root, schema_file)?;
            let raw = tokio::fs::read_to_string(&full_path)
                .await
                .map_err(|e| format!("Failed to read schema file {}: {}", schema_file, e))?;
            let schema: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("Schema file {} is not valid JSON: {}", schema_file, e))?;
            let name = std::path::Path::new(schema_file)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "schema".to_string());
            Ok(Some(serde_json::json!({
                "type": "json_schema",
                "json_schema": { "name": name, "strict": true, "schema": schema },
            })))
        }
        _ => Ok(None),
    }
}

#[derive(Debug, Clone)]
pub struct LlmCallOptions<'a> {
    pub provider: &'a str,
    pub server_url: &'a str,
    pub model: &'a str,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i32>,
    pub thinking_budget: Option<i32>,
    pub response_format: Option<serde_json::Value>,
}

/// Make a single LLM call. Returns a structured `LlmCallOutcome` with the raw
/// content plus token-usage metrics for the per-row execution state. Caller
/// is responsible for retry on rate-limits.
pub async fn attempt_llm_call(
    client: &Client,
    prompt: String,
    opts: &LlmCallOptions<'_>,
) -> Result<LlmCallOutcome, String> {
    match opts.provider.to_lowercase().as_str() {
        "local" | "openai" | "custom" | "google" | "" => {}
        "anthropic" => {
            return Err("Anthropic provider is not yet supported. Use Local/OpenAI/Custom \
                 pointed at an OpenAI-compatible endpoint."
                .to_string());
        }
        other => return Err(format!("Unknown provider: {}", other)),
    }

    if Url::parse(opts.server_url).is_err() {
        return Err(format!("Invalid server URL: {}", opts.server_url));
    }

    let request = LlmRequest {
        model: opts.model.to_string(),
        messages: vec![Message { role: "user".into(), content: prompt }],
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        response_format: opts.response_format.clone(),
        reasoning_effort: thinking_budget_to_effort(opts.thinking_budget),
    };

    let endpoint_url = if opts.server_url.ends_with("/v1") {
        format!("{}/chat/completions", opts.server_url)
    } else if opts.server_url.ends_with('/') {
        format!("{}v1/chat/completions", opts.server_url)
    } else {
        format!("{}/v1/chat/completions", opts.server_url)
    };

    let backend = format!("{}:{}", opts.provider.to_lowercase(), opts.model);
    debug!("Calling LLM API at {}", endpoint_url);

    let started = std::time::Instant::now();
    let response = client
        .post(&endpoint_url)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if response.status().as_u16() == 429 {
        return Err("Rate limit exceeded (429)".to_string());
    }
    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("API returned status {}: {}", status, body_text));
    }

    let response_text =
        response.text().await.map_err(|e| format!("Failed to read response body: {}", e))?;
    let llm_response: LlmResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse response JSON ({}): {}", e, response_text))?;
    let latency_ms = started.elapsed().as_millis() as i64;

    let choice = llm_response.choices.first().ok_or("No choices in response")?;
    let content = choice.message.extract_content().to_string();

    let (input_tokens, output_tokens, cached_tokens) = match llm_response.usage {
        Some(u) => {
            let cached = u
                .prompt_tokens_details
                .as_ref()
                .and_then(|d| d.cached_tokens)
                .or(u.cached_tokens);
            (u.prompt_tokens, u.completion_tokens, cached)
        }
        None => (None, None, None),
    };

    Ok(LlmCallOutcome {
        content,
        input_tokens,
        output_tokens,
        cached_tokens,
        latency_ms: Some(latency_ms),
        backend: Some(backend),
    })
}

/// Retry an LLM call up to `max_retries` times on rate-limit errors with
/// exponential backoff. Other errors propagate immediately.
pub async fn attempt_llm_call_with_retry(
    client: &Client,
    prompt: String,
    opts: &LlmCallOptions<'_>,
    max_retries: u32,
) -> Result<LlmCallOutcome, String> {
    let base_delay = Duration::from_secs(1);
    for attempt in 0..=max_retries {
        match attempt_llm_call(client, prompt.clone(), opts).await {
            Ok(out) => return Ok(out),
            Err(e) => {
                let is_rate_limit = e.contains("429") || e.contains("rate limit");
                if attempt < max_retries && is_rate_limit {
                    let delay = base_delay * 2u32.pow(attempt);
                    info!("Rate limited, retrying in {:?}", delay);
                    sleep(delay).await;
                    continue;
                }
                if !is_rate_limit {
                    warn!(error = %e, "LLM call failed (non-retryable)");
                }
                return Err(e);
            }
        }
    }
    Err("Max retries exceeded".to_string())
}
