use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MethodManifest {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<MethodFileRef>,
    #[serde(default)]
    pub workflow: MethodWorkflow,
    #[serde(default, skip_serializing_if = "serde_yaml::Value::is_null")]
    pub parameters: serde_yaml::Value,
    #[serde(default, skip_serializing_if = "serde_yaml::Value::is_null")]
    pub provider: serde_yaml::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MethodFileRef {
    pub id: String,
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct MethodWorkflow {
    #[serde(default)]
    pub nodes: Vec<MethodWorkflowNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MethodWorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "serde_yaml::Value::is_null")]
    pub config: serde_yaml::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMethodInput {
    pub method: MethodManifest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodPreflightBlocker {
    pub code: String,
    pub message: String,
    pub file_id: Option<String>,
    pub file_kind: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodPreflightResult {
    pub status: String,
    pub blockers: Vec<MethodPreflightBlocker>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodSummary {
    pub id: String,
    pub title: String,
    pub content_hash: String,
    pub folder_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodExecutionSummary {
    pub id: i64,
    pub method_id: String,
    pub method_content_hash: String,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodExecutionNodeSummary {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: String,
    pub node_type: String,
    pub status: String,
    pub output_ref: Option<String>,
    pub error_message: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodExecutionEventSummary {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: Option<String>,
    pub event_type: String,
    pub payload_json: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MethodArtifactSummary {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: Option<String>,
    pub artifact_type: String,
    pub storage_kind: String,
    pub storage_ref: String,
    pub content_hash: String,
    pub created_at: String,
}
