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
    pub method: MethodDraft,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MethodDraft {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub objective: String,
    pub lifecycle: MethodLifecycleState,
    #[serde(default)]
    pub resources: Vec<MethodDraftResource>,
    #[serde(default)]
    pub nodes: Vec<MethodDraftNode>,
    #[serde(default)]
    pub edges: Vec<MethodDraftEdge>,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default)]
    pub provider_config: serde_json::Value,
    #[serde(default)]
    pub outputs: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    pub readiness: MethodDraftReadiness,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MethodDraftResource {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub consumed_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MethodDraftNode {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MethodDraftEdge {
    pub from: String,
    pub to: String,
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
#[serde(rename_all = "camelCase")]
pub struct ReplaceMethodDraftGraphInput {
    pub nodes: Vec<MethodDraftNode>,
    pub edges: Vec<MethodDraftEdge>,
    #[serde(default)]
    pub resources: Option<Vec<MethodDraftResource>>,
}

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
