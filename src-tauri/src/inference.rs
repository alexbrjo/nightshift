use crate::db::{AppState, Result};
use minijinja::{Environment, context};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::time::{Duration, sleep};
use futures_util::stream::StreamExt;
use rand::prelude::SliceRandom;

async fn load_file_helper(state: &AppState, path: &str) -> Result<String> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| crate::db::DbError::ProjectNotFound("No project".to_string()))?;
    
    let full_path = std::path::PathBuf::from(project_path).join(path);
    Ok(tokio::fs::read_to_string(&full_path).await?)
}

#[derive(Debug, Deserialize)]
pub struct InferenceJobConfig {
    pub name: String,
    pub template_path: String,
    pub input_files: Option<Vec<String>>,
    pub provider: ProviderConfig,
    pub sampling: SamplingConfig,
    pub output_format: OutputFormat,
}

#[derive(Debug, Deserialize)]
pub struct ProviderConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<i32>,
    pub thinking_budget: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct SamplingConfig {
    pub strategy: SamplingStrategy,
    pub random_seed: Option<u64>,
    pub sample_count: Option<usize>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum SamplingStrategy {
    Single,
    Random,
    Exhaustive,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Unstructured,
    PlainJson,
    JsonSchema(String),
}

#[derive(Debug, Serialize)]
pub struct InferenceJobResult {
    pub job_id: String,
    pub total_samples: usize,
    pub completed: usize,
    pub errored: usize,
    pub samples: Vec<SampleResult>,
}

#[derive(Debug, Serialize)]
pub struct SampleResult {
    pub index: usize,
    pub rendered_prompt: Option<String>,
    pub raw_response: Option<String>,
    pub parsed_content: Option<String>,
    pub token_usage: u32,
    pub latency_ms: u64,
    pub status: String,
    pub error_message: Option<String>,
}

pub async fn run_inference_job(
    state: Arc<AppState>,
    config: InferenceJobConfig,
) -> Result<InferenceJobResult> {
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;

    // Load template
    let template_content = load_file_helper(&state, &config.template_path).await?;
    let mut env = Environment::new();
    env.add_template("prompt", &template_content)?;
    let template = env.get_template("prompt")?;

    // Load input data
    let inputs = load_input_files(&state, &config.input_files.unwrap_or_default()).await?;

    // Generate samples based on strategy
    let sample_inputs = generate_samples(&inputs, &config.sampling)?;

    let mut results = Vec::new();
    let mut completed = 0;
    let mut errored = 0;

    for (index, input_vars) in sample_inputs.iter().enumerate() {
        let result = run_single_sample(
            &client,
            &config.provider,
            &template,
            input_vars,
            index,
        ).await;

        match result {
            Ok(sample_result) => {
                completed += 1;
                results.push(sample_result);
            }
            Err(e) => {
                errored += 1;
                results.push(SampleResult {
                    index,
                    rendered_prompt: None,
                    raw_response: None,
                    parsed_content: None,
                    token_usage: 0,
                    latency_ms: 0,
                    status: "error".to_string(),
                    error_message: Some(e.to_string()),
                });
            }
        }

        // Rate limiting - small delay between requests
        sleep(Duration::from_millis(100)).await;
    }

    Ok(InferenceJobResult {
        job_id: uuid::Uuid::new_v4().to_string(),
        total_samples: sample_inputs.len(),
        completed,
        errored,
        samples: results,
    })
}

pub async fn load_input_files(state: &AppState, paths: &[String]) -> Result<Vec<serde_json::Value>> {
    let mut all_inputs = Vec::new();

    for path in paths {
        let content = load_file_helper(state, path).await?;
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        match ext {
            "json" => {
                let data: serde_json::Value = serde_json::from_str(&content)?;
                if let Some(arr) = data.as_array() {
                    all_inputs.extend(arr.clone());
                } else {
                    all_inputs.push(data);
                }
            }
            "jsonl" => {
                for line in content.lines() {
                    if !line.trim().is_empty() {
                        if let Ok(value) = serde_json::from_str(line) {
                            all_inputs.push(value);
                        }
                    }
                }
            }
            "csv" => {
                let mut rdr = csv::Reader::from_reader(content.as_bytes());
                for result in rdr.records() {
                    if let Ok(record) = result {
                        let obj: serde_json::Value = record.iter()
                            .enumerate()
                            .map(|(i, f)| (format!("col{}", i), f))
                            .collect();
                        all_inputs.push(obj);
                    }
                }
            }
            _ => {}
        }
    }

    Ok(all_inputs)
}

fn generate_samples(
    inputs: &[serde_json::Value],
    config: &SamplingConfig,
) -> Result<Vec<serde_json::Value>> {
    match config.strategy {
        SamplingStrategy::Single => {
            inputs.first().cloned().map(|v| vec![v]).ok_or_else(|| {
                crate::db::DbError::JobNotFound("No input data".to_string())
            })
        }
        SamplingStrategy::Random => {
            let count = config.sample_count.unwrap_or(10).min(inputs.len());
            let mut rng = rand::thread_rng();
            let indices: Vec<usize> = (0..inputs.len()).collect();
            let selected: Vec<usize> = if count >= inputs.len() {
                indices
            } else {
                indices.choose_multiple(&mut rng, count).copied().collect()
            };
            Ok(selected.iter().map(|i| inputs[*i].clone()).collect())
        }
        SamplingStrategy::Exhaustive => {
            Ok(inputs.to_vec())
        }
    }
}

async fn run_single_sample(
    client: &Client,
    provider: &ProviderConfig,
    template: &minijinja::Template<'_, '_>,
    input_vars: &serde_json::Value,
    index: usize,
) -> Result<SampleResult> {
    let start = std::time::Instant::now();

    // Render prompt
    let rendered_prompt = template.render(context! {
        input_vars => input_vars
    })?;

    // Build request
    let messages = vec![
        serde_json::json!({ "role": "user", "content": rendered_prompt }),
    ];

    let mut request_body = serde_json::json!({
        "model": provider.model,
        "messages": messages,
        "stream": true,
    });

    if let Some(temp) = provider.temperature {
        request_body["temperature"] = serde_json::json!(temp);
    }
    if let Some(max_tokens) = provider.max_tokens {
        request_body["max_tokens"] = serde_json::json!(max_tokens);
    }

    // Make API call with streaming
    let mut request = client.post(&provider.base_url)
        .header("Content-Type", "application/json");

    if let Some(api_key) = &provider.api_key {
        request = request.bearer_auth(api_key);
    }

    let response = request.json(&request_body).send().await?;
    
    if !response.status().is_success() {
        let error_text = response.text().await?;
        return Err(crate::db::DbError::JobNotFound(format!(
            "API error: {}", error_text
        )));
    }

    // Process streaming response
    let mut raw_response = String::new();
    let mut token_usage: u32 = 0;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let text = String::from_utf8_lossy(&chunk);
        
        for line in text.lines() {
            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" {
                    break;
                }
                
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(choice) = json.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) {
                        if let Some(delta) = choice.get("delta").and_then(|d| d.get("content")).and_then(|c| c.as_str()) {
                            raw_response.push_str(delta);
                            token_usage += 1;
                        }
                    }
                }
            }
        }
    }

    let latency_ms = start.elapsed().as_millis() as u64;

    Ok(SampleResult {
        index,
        rendered_prompt: Some(rendered_prompt),
        raw_response: Some(raw_response.clone()),
        parsed_content: parse_output(&raw_response, &config.output_format)?,
        token_usage,
        latency_ms,
        status: "completed".to_string(),
        error_message: None,
    })
}

async fn load_file_helper(state: &AppState, path: &str) -> Result<String> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| crate::db::DbError::ProjectNotFound("No project".to_string()))?;
    
    let full_path = std::path::PathBuf::from(project_path).join(path);
    Ok(tokio::fs::read_to_string(&full_path).await?)
}

fn parse_output(content: &str, format: &OutputFormat) -> Result<Option<String>> {
    match format {
        OutputFormat::Unstructured => Ok(Some(content.to_string())),
        OutputFormat::PlainJson => {
            // Try to extract JSON from response
            if content.trim().starts_with('{') || content.trim().starts_with('[') {
                Ok(Some(content.to_string()))
            } else {
                Ok(None)
            }
        }
        OutputFormat::JsonSchema(schema) => {
            // Validate against schema (simplified - would use jsonschema crate in production)
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(content) {
                Ok(Some(serde_json::to_string_pretty(&value)?))
            } else {
                Ok(None)
            }
        }
    }
}
