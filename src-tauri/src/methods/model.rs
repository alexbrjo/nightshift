use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MethodLifecycleState {
    Drafting,
    Ready,
    Executing,
    Completed,
    Failed,
}

impl MethodLifecycleState {
    #[allow(dead_code)]
    pub fn can_transition_to(self, next: MethodLifecycleState) -> bool {
        use MethodLifecycleState::*;
        matches!(
            (self, next),
            (Drafting, Drafting)
                | (Drafting, Ready)
                | (Ready, Drafting)
                | (Ready, Ready)
                | (Ready, Executing)
                | (Executing, Completed)
                | (Executing, Failed)
                | (Failed, Drafting)
                | (Completed, Drafting)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AgentThreadState {
    pub thread_id: String,
    pub project_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct DraftMethodState {
    pub method: MethodDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SavedMethodState {
    pub summary: MethodSummaryForState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct FrozenMethodBundleState {
    pub method_id: String,
    pub manifest_hash: String,
    pub folder_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MethodExecutionState {
    pub execution_id: i64,
    pub method_id: String,
    pub status: MethodLifecycleState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MethodArtifactState {
    pub artifact_id: i64,
    pub execution_id: i64,
    pub node_id: Option<String>,
    pub artifact_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MethodSummaryForState {
    pub id: String,
    pub title: String,
    pub content_hash: String,
}

/// Canonical durable Method document.
///
/// Add new persisted Method fields here. Keep UI-only or execution-derived state
/// (readiness, lifecycle, graph edges, resource status, layout, execution status)
/// in derived view helpers instead of serialized Method structs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MethodDocument {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub objective: String,
    #[serde(default)]
    pub workflow: MethodWorkflow,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default)]
    pub provider: serde_json::Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<String>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MethodDraftReadiness {
    pub status: MethodLifecycleState,
    #[serde(default)]
    pub blockers: Vec<MethodDraftIssue>,
    #[serde(default)]
    pub warnings: Vec<MethodDraftIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MethodDraftIssue {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMethodDraftInput {
    pub title: Option<String>,
    pub objective: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMethodDraftMetadataInput {
    pub title: Option<String>,
    pub objective: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMethodDraftExecutionConfigInput {
    #[serde(default)]
    pub provider: Option<serde_json::Value>,
    #[serde(default)]
    pub parameters: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceMethodDraftGraphInput {
    pub workflow: MethodWorkflow,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NightshiftConfig {
    #[serde(default)]
    pub provider_profiles: std::collections::HashMap<String, ProviderProfile>,
    #[serde(default)]
    pub api_keys: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub model_defaults: ModelDefaults,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelDefaults {
    #[serde(default)]
    pub provider_profile: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct MethodWorkflow {
    #[serde(default)]
    pub nodes: Vec<MethodWorkflowNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MethodWorkflowNode {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub config: serde_json::Value,
}

impl MethodWorkflowNode {
    pub fn is_resource(&self) -> bool {
        self.node_type == "resource"
    }

    pub fn is_runnable(&self) -> bool {
        !self.is_resource()
    }

    pub fn label_or_id(&self) -> &str {
        if self.label.trim().is_empty() { &self.id } else { &self.label }
    }
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
pub struct ExecutionFileSummary {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: Option<String>,
    pub file_type: String,
    pub path: String,
    pub content_hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OutputItem {
    pub id: i64,
    pub execution_id: i64,
    pub node_id: String,
    pub job_id: Option<i64>,
    pub sample_index: Option<i64>,
    pub data: serde_json::Value,
    pub created_at: String,
}

pub type MethodArtifactSummary = ExecutionFileSummary;
