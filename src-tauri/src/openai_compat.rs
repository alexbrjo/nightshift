// Shared OpenAI-compatible chat-completions helper used by both
// `commands::experiments::chat_complete` (the planner) and
// `job_executor::attempt_llm_call` (per-sample inference).
//
// Why this exists: aisdk would have been the natural home for this code but
// its response parser hard-requires fields that LM Studio (the most common
// local-LLM setup) doesn't always emit (notably `id`). Until that's fixed
// upstream we keep a small in-house wrapper with permissive parsing, but
// concentrated in one place so the call sites stay tidy.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct ChatRequest<'a> {
    pub model: &'a str,
    pub messages: &'a [ChatMessage],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

/// Permissive response shape — every field is optional except `choices`
/// (and even those default to empty), so we tolerate non-conforming
/// servers (LM Studio, llama.cpp, custom proxies) that omit `id`,
/// `created`, etc.
#[derive(Debug, Deserialize)]
pub struct ChatResponse {
    /// Many local servers (LM Studio, llama.cpp) omit `id`; kept Optional and
    /// allowed-to-be-unread so deserialization stays permissive.
    #[allow(dead_code)]
    #[serde(default)]
    pub id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
pub struct Choice {
    pub message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
pub struct ChoiceMessage {
    #[serde(default)]
    pub content: Option<String>,
    /// Some thinking-capable models (Qwen3, DeepSeek-R1, …) put the
    /// answer here when `content` is empty.
    #[serde(default)]
    pub reasoning_content: Option<String>,
}

impl ChoiceMessage {
    pub fn extract_content(&self) -> &str {
        let primary = self.content.as_deref().unwrap_or("");
        if !primary.trim().is_empty() {
            return primary;
        }
        self.reasoning_content.as_deref().unwrap_or("")
    }
}

/// Result of a single non-streaming chat completion. Splits the assistant
/// content from any reasoning/CoT trace so callers can surface them
/// independently in debug UIs.
#[derive(Debug, Default)]
pub struct ChatOutcome {
    pub content: String,
    pub reasoning: Option<String>,
    pub raw_body: String,
}

/// Compute the absolute /v1/chat/completions URL given the user's
/// configured server URL. We accept all three common shapes:
///   - `https://host`               -> append `/v1/chat/completions`
///   - `https://host/`              -> append `v1/chat/completions`
///   - `https://host/v1`            -> append `/chat/completions`
pub fn endpoint_url(server_url: &str) -> String {
    if server_url.ends_with("/v1") {
        format!("{}/chat/completions", server_url)
    } else if server_url.ends_with('/') {
        format!("{}v1/chat/completions", server_url)
    } else {
        format!("{}/v1/chat/completions", server_url)
    }
}

/// Map our 0-based "thinking budget" tokens-budget integer onto OpenAI's
/// coarse `reasoning_effort` enum. None / 0 / negative disables.
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

/// POST a single non-streaming chat completion to the given OpenAI-compatible
/// endpoint. The 60-second timeout matches what `JobExecutor` used; bump if
/// anything ever needs longer.
pub async fn chat_completion(
    server_url: &str,
    request: &ChatRequest<'_>,
) -> Result<ChatOutcome, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client build: {}", e))?;

    let url = endpoint_url(server_url);
    let response = client
        .post(&url)
        .json(request)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if response.status().as_u16() == 429 {
        return Err("Rate limit exceeded (429)".to_string());
    }
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API returned status {}: {}", status, body));
    }

    let raw = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let parsed: ChatResponse = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse response JSON ({}): {}", e, raw))?;

    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "No choices in response".to_string())?;

    let content = choice.message.extract_content().to_string();
    let reasoning = choice
        .message
        .reasoning_content
        .filter(|s| !s.trim().is_empty());

    let mut raw_body = raw;
    if raw_body.len() > 65_536 {
        raw_body.truncate(65_536);
        raw_body.push_str("\n…[truncated]");
    }

    Ok(ChatOutcome { content, reasoning, raw_body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_handles_trailing_v1_and_slash() {
        assert_eq!(
            endpoint_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(endpoint_url("http://x/"), "http://x/v1/chat/completions");
        assert_eq!(endpoint_url("http://x"), "http://x/v1/chat/completions");
    }

    #[test]
    fn extract_content_falls_back_to_reasoning_when_content_empty() {
        let msg = ChoiceMessage {
            content: Some("".into()),
            reasoning_content: Some(r#"{"word":"gehen"}"#.into()),
        };
        assert_eq!(msg.extract_content(), r#"{"word":"gehen"}"#);
    }

    #[test]
    fn extract_content_prefers_content_when_present() {
        let msg = ChoiceMessage {
            content: Some("real answer".into()),
            reasoning_content: Some("internal monologue".into()),
        };
        assert_eq!(msg.extract_content(), "real answer");
    }

    #[test]
    fn parses_lm_studio_response_without_id_field() {
        // LM Studio (and some other local servers) omit `id`; aisdk's
        // strict parser falls over on this exact shape, which is what
        // motivated keeping our own permissive parser.
        let body = r#"{
            "object": "chat.completion",
            "model": "qwen",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "hi" },
                "finish_reason": "stop"
            }]
        }"#;
        let parsed: ChatResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.id, None);
        assert_eq!(parsed.choices[0].message.extract_content(), "hi");
    }

    #[test]
    fn thinking_budget_to_effort_buckets() {
        assert_eq!(thinking_budget_to_effort(None), None);
        assert_eq!(thinking_budget_to_effort(Some(0)), None);
        assert_eq!(thinking_budget_to_effort(Some(500)), Some("low".into()));
        assert_eq!(thinking_budget_to_effort(Some(1000)), Some("medium".into()));
        assert_eq!(thinking_budget_to_effort(Some(2000)), Some("high".into()));
    }
}
