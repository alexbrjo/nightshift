use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct InferenceJob {
    pub id: i64,
    pub job_type: String,
    pub name: String,
    pub prompt_file: String,
    pub data_source: String,
    pub provider: String,
    pub model: String,
    pub server_url: String,
    pub output_mode: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<i32>,
    pub thinking_budget: Option<i32>,
    pub samples: i32,
    pub strategy: String,
    pub json_schema_file: Option<String>,
    pub transform_script_file: Option<String>,
    pub transform_error_mode: Option<String>,
    pub transform_output_mode: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct JobFailure {
    pub id: i64,
    pub job_id: i64,
    pub sample_index: i64,
    pub error: String,
    pub created_at: String,
}

/// Input parameters for creating/updating an inference job
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceJobInput {
    pub name: String,
    #[serde(rename = "promptFile")]
    pub prompt_file: String,
    #[serde(rename = "dataSource")]
    pub data_source: String,
    pub provider: String,
    pub model: String,
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "outputMode")]
    pub output_mode: String,
    pub temperature: Option<f32>,
    #[serde(rename = "maxTokens")]
    pub max_tokens: Option<i32>,
    #[serde(rename = "thinkingBudget")]
    pub thinking_budget: Option<i32>,
    pub samples: i32,
    pub strategy: String,
    #[serde(rename = "jsonSchemaFile")]
    pub json_schema_file: Option<String>,
}

/// Input parameters for creating a transform job.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformJobInput {
    pub name: String,
    #[serde(rename = "dataSource")]
    pub data_source: String,
    #[serde(rename = "scriptFile")]
    pub script_file: String,
    #[serde(rename = "errorMode")]
    pub error_mode: String,
    #[serde(rename = "outputMode")]
    pub output_mode: String,
}
