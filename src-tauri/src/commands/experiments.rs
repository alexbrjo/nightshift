// Experiment Designer backend.
//
// An "experiment" is a self-contained `.nsexp` zip bundle living in
// `<project_root>/experiments/`. The bundle holds a YAML manifest plus
// content-addressed snapshots of every file the experiment references
// (prompts, data, JSON schemas, transform/eval scripts).
//
// This module provides:
//   - Types mirroring the YAML schema documented in DEVELOPER_GUIDE.md.
//   - `save_experiment` — snapshot referenced files + write the zip atomically.
//   - `list_experiments` / `get_experiment` — read manifests from bundles.
//   - `read_bundle_file` — fetch an embedded snapshot (used by the YAML preview).
//   - `chat_complete` — thin wrapper over the existing OpenAI-compatible HTTP
//     plumbing so the planner UI can drive a multi-turn chat without going
//     through the per-sample JobExecutor.

use std::collections::HashSet;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use zip::write::FileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::database::DatabaseState;

// ---------- YAML schema ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Experiment {
    pub schema_version: u32,
    pub id: String,
    /// Free-form goal text. May be a falsifiable hypothesis OR a more
    /// open-ended benchmark / comparison statement (e.g. "compare three
    /// edge-sized models on German verb flashcards"). Empty is allowed.
    #[serde(default)]
    pub hypothesis: String,
    pub created_at: String,
    pub independent_variable: IndependentVariable,
    pub controlled_variables: ControlledVariables,
    pub trial_template: TrialTemplate,
    #[serde(default)]
    pub evals: Vec<EvalMetric>,
    pub aggregate: Aggregate,
    pub analysis_agent: AnalysisAgent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndependentVariable {
    pub name: String,
    pub values: Vec<serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ControlledVariables {
    pub provider: String,
    /// `model` is omittable when `independent_variable.name == "model"` —
    /// the runner substitutes each IV value in turn, so a fixed default
    /// would be contradictory. Required otherwise. Validation enforces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub server_url: String,
    /// Same logic as `model`: omittable when IV sweeps over `prompt_file`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_file: Option<String>,
    pub data_source: String,
    pub output_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_schema_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_budget: Option<i32>,
    pub samples: i32,
    pub strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrialTemplate {
    pub nodes: Vec<TrialNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TrialNode {
    Inference {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        json_schema_file: Option<String>,
        #[serde(default)]
        depends_on: Vec<String>,
    },
    Transform {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        script_file: String,
        #[serde(default = "default_error_mode")]
        error_mode: String,
        #[serde(default = "default_output_mode")]
        output_mode: String,
        #[serde(default)]
        depends_on: Vec<String>,
    },
}

fn default_error_mode() -> String {
    "skip".into()
}
fn default_output_mode() -> String {
    "one_to_one".into()
}

impl TrialNode {
    pub fn id(&self) -> &str {
        match self {
            TrialNode::Inference { id, .. } | TrialNode::Transform { id, .. } => id,
        }
    }
    pub fn depends_on(&self) -> &[String] {
        match self {
            TrialNode::Inference { depends_on, .. } | TrialNode::Transform { depends_on, .. } => {
                depends_on
            }
        }
    }
    /// Mutable list of every `*_file` path stored on this node, so we can
    /// rewrite project-relative paths to bundle-internal `files/<sha>.<ext>`
    /// paths during snapshotting without duplicating the match logic.
    fn file_paths_mut(&mut self) -> Vec<&mut String> {
        match self {
            TrialNode::Inference { prompt_file, json_schema_file, .. } => {
                let mut v = vec![];
                if let Some(p) = prompt_file.as_mut() {
                    v.push(p);
                }
                if let Some(p) = json_schema_file.as_mut() {
                    v.push(p);
                }
                v
            }
            TrialNode::Transform { script_file, .. } => vec![script_file],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalMetric {
    pub name: String,
    pub source: String,
    pub field: String,
    pub agg: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Aggregate {
    pub group_by: Vec<String>,
    pub metrics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalysisAgent {
    pub provider: String,
    pub model: String,
    pub system_prompt_file: String,
    pub output_file: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperimentSummary {
    pub id: String,
    pub hypothesis: String,
    pub created_at: String,
    pub independent_variable_name: String,
    pub bundle_path: String,
}

// ---------- Validation ----------

const ALLOWED_IV_NAMES: &[&str] =
    &["model", "temperature", "prompt_file", "max_tokens", "system_prompt"];

fn require_nonempty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{} must not be empty", label))
    } else {
        Ok(())
    }
}

fn validate(experiment: &Experiment) -> Result<(), String> {
    require_nonempty("experiment.id", &experiment.id)?;
    if experiment.id.contains('/') || experiment.id.contains("..") {
        return Err("experiment.id must not contain '/' or '..'".into());
    }
    // hypothesis is intentionally optional — a benchmark / comparison run is
    // a valid experiment even without a falsifiable claim.
    if !ALLOWED_IV_NAMES.contains(&experiment.independent_variable.name.as_str()) {
        return Err(format!(
            "independent_variable.name must be one of {:?}",
            ALLOWED_IV_NAMES
        ));
    }
    if experiment.independent_variable.values.len() < 2 {
        return Err(
            "independent_variable.values must contain at least 2 entries — a sweep needs something to compare".into(),
        );
    }
    let mut seen = HashSet::new();
    for v in &experiment.independent_variable.values {
        let key = serde_yaml::to_string(v).unwrap_or_default();
        if !seen.insert(key) {
            return Err("independent_variable.values must be unique".into());
        }
    }
    let cv = &experiment.controlled_variables;
    let iv_name = experiment.independent_variable.name.as_str();
    require_nonempty("controlled_variables.provider", &cv.provider)?;
    require_nonempty("controlled_variables.server_url", &cv.server_url)?;
    require_nonempty("controlled_variables.data_source", &cv.data_source)?;
    require_nonempty("controlled_variables.output_mode", &cv.output_mode)?;
    require_nonempty("controlled_variables.strategy", &cv.strategy)?;
    // `model` and `prompt_file` are required only when they are NOT the IV.
    if iv_name != "model" {
        match cv.model.as_deref() {
            Some(s) if !s.trim().is_empty() => {}
            _ => return Err("controlled_variables.model must not be empty (independent_variable is not 'model')".into()),
        }
    }
    if iv_name != "prompt_file" {
        match cv.prompt_file.as_deref() {
            Some(s) if !s.trim().is_empty() => {}
            _ => return Err("controlled_variables.prompt_file must not be empty (independent_variable is not 'prompt_file')".into()),
        }
    }
    if cv.samples < 1 {
        return Err("controlled_variables.samples must be >= 1".into());
    }
    if cv.output_mode == "JSON Schema" && cv.json_schema_file.as_deref().unwrap_or("").trim().is_empty() {
        return Err(
            "output_mode is 'JSON Schema' but no controlled_variables.json_schema_file is set".into(),
        );
    }
    if experiment.trial_template.nodes.is_empty() {
        return Err("trial_template.nodes must contain at least one node".into());
    }
    let aa = &experiment.analysis_agent;
    require_nonempty("analysis_agent.provider", &aa.provider)?;
    require_nonempty("analysis_agent.model", &aa.model)?;
    require_nonempty("analysis_agent.system_prompt_file", &aa.system_prompt_file)?;
    require_nonempty("analysis_agent.output_file", &aa.output_file)?;
    let ids: HashSet<&str> =
        experiment.trial_template.nodes.iter().map(|n| n.id()).collect();
    if ids.len() != experiment.trial_template.nodes.len() {
        return Err("trial_template node ids must be unique".into());
    }
    for node in &experiment.trial_template.nodes {
        for dep in node.depends_on() {
            if !ids.contains(dep.as_str()) {
                return Err(format!(
                    "trial_template node '{}' depends on unknown id '{}'",
                    node.id(),
                    dep
                ));
            }
        }
    }
    detect_cycles(&experiment.trial_template.nodes)?;
    Ok(())
}

fn detect_cycles(nodes: &[TrialNode]) -> Result<(), String> {
    use std::collections::HashMap;
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Unseen,
        InProgress,
        Done,
    }
    let mut marks: HashMap<&str, Mark> = nodes.iter().map(|n| (n.id(), Mark::Unseen)).collect();
    let by_id: HashMap<&str, &TrialNode> = nodes.iter().map(|n| (n.id(), n)).collect();

    fn visit<'a>(
        id: &'a str,
        marks: &mut std::collections::HashMap<&'a str, Mark>,
        by_id: &std::collections::HashMap<&'a str, &'a TrialNode>,
    ) -> Result<(), String> {
        match marks.get(id).copied().unwrap_or(Mark::Unseen) {
            Mark::Done => return Ok(()),
            Mark::InProgress => {
                return Err(format!("trial_template has a cycle through '{}'", id))
            }
            Mark::Unseen => {}
        }
        marks.insert(id, Mark::InProgress);
        if let Some(node) = by_id.get(id) {
            for dep in node.depends_on() {
                visit(dep.as_str(), marks, by_id)?;
            }
        }
        marks.insert(id, Mark::Done);
        Ok(())
    }
    for n in nodes {
        visit(n.id(), &mut marks, &by_id)?;
    }
    Ok(())
}

// ---------- Snapshot + zip writing ----------

/// Read a project-relative path → write its bytes into the in-memory zip at
/// `files/<sha>.<ext>` (deduplicated). Returns the bundle-internal path that
/// should replace the original in the manifest.
fn snapshot_into_zip(
    project_root: &Path,
    relative: &str,
    seen: &mut HashSet<String>,
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
) -> Result<String, String> {
    if relative.starts_with("files/") {
        // Already a bundle path — caller passed in something already snapshotted.
        return Ok(relative.to_string());
    }
    let full = project_root.join(relative);
    let bytes = std::fs::read(&full)
        .map_err(|e| format!("Failed to read referenced file '{}': {}", relative, e))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha = format!("{:x}", hasher.finalize());
    let ext = Path::new(relative)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let bundle_path = format!("files/{}.{}", sha, ext);
    if seen.insert(bundle_path.clone()) {
        zip.start_file(&bundle_path, FileOptions::default())
            .map_err(|e| format!("zip: {}", e))?;
        zip.write_all(&bytes).map_err(|e| format!("zip write: {}", e))?;
    }
    Ok(bundle_path)
}

/// Walk every `*_file` field on an Experiment, snapshotting each into the zip
/// and rewriting the path in-place to the resulting `files/<sha>.<ext>`.
fn snapshot_all_files(
    experiment: &mut Experiment,
    project_root: &Path,
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    let cv = &mut experiment.controlled_variables;
    if let Some(p) = cv.prompt_file.as_mut() {
        *p = snapshot_into_zip(project_root, p, &mut seen, zip)?;
    }
    cv.data_source = snapshot_into_zip(project_root, &cv.data_source, &mut seen, zip)?;
    if let Some(s) = cv.json_schema_file.as_mut() {
        *s = snapshot_into_zip(project_root, s, &mut seen, zip)?;
    }
    for node in &mut experiment.trial_template.nodes {
        for path in node.file_paths_mut() {
            *path = snapshot_into_zip(project_root, path, &mut seen, zip)?;
        }
    }
    let aa = &mut experiment.analysis_agent;
    aa.system_prompt_file = snapshot_into_zip(project_root, &aa.system_prompt_file, &mut seen, zip)?;
    Ok(())
}

fn project_root(db: &DatabaseState) -> Result<PathBuf, String> {
    let root = db.get_project_root();
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("No project folder is open".into());
    }
    Ok(root)
}

fn experiments_dir(project_root: &Path) -> PathBuf {
    project_root.join("experiments")
}

fn bundle_path(project_root: &Path, id: &str) -> PathBuf {
    experiments_dir(project_root).join(format!("{}.nsexp", id))
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn save_experiment(
    db: State<'_, DatabaseState>,
    mut experiment: Experiment,
) -> Result<ExperimentSummary, String> {
    let root = project_root(&db)?;
    validate(&experiment)?;

    let dir = experiments_dir(&root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create experiments/: {}", e))?;

    let bundle = bundle_path(&root, &experiment.id);
    if bundle.exists() {
        return Err(format!("Experiment '{}' already exists", experiment.id));
    }

    let buf = Cursor::new(Vec::<u8>::new());
    let mut zip = ZipWriter::new(buf);

    snapshot_all_files(&mut experiment, &root, &mut zip)?;

    let yaml = serde_yaml::to_string(&experiment)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    zip.start_file("experiment.yaml", FileOptions::default())
        .map_err(|e| format!("zip: {}", e))?;
    zip.write_all(yaml.as_bytes()).map_err(|e| format!("zip write: {}", e))?;

    let cursor = zip.finish().map_err(|e| format!("zip finalize: {}", e))?;
    let bytes = cursor.into_inner();

    let tmp = bundle.with_extension("nsexp.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write bundle: {}", e))?;
    std::fs::rename(&tmp, &bundle)
        .map_err(|e| format!("Failed to finalize bundle: {}", e))?;

    Ok(ExperimentSummary {
        id: experiment.id.clone(),
        hypothesis: experiment.hypothesis.clone(),
        created_at: experiment.created_at.clone(),
        independent_variable_name: experiment.independent_variable.name.clone(),
        bundle_path: bundle.to_string_lossy().to_string(),
    })
}

fn read_manifest(path: &Path) -> Result<Experiment, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Failed to read bundle '{}': {}", path.display(), e))?;
    let mut zip = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut yaml_file =
        zip.by_name("experiment.yaml").map_err(|_| "Bundle missing experiment.yaml".to_string())?;
    let mut s = String::new();
    yaml_file.read_to_string(&mut s).map_err(|e| format!("Failed to read manifest: {}", e))?;
    serde_yaml::from_str(&s).map_err(|e| format!("Manifest parse error: {}", e))
}

#[tauri::command]
pub async fn list_experiments(
    db: State<'_, DatabaseState>,
) -> Result<Vec<ExperimentSummary>, String> {
    let root = project_root(&db)?;
    let dir = experiments_dir(&root);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))? {
        let entry = entry.map_err(|e| format!("dir entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("nsexp") {
            continue;
        }
        match read_manifest(&path) {
            Ok(m) => out.push(ExperimentSummary {
                id: m.id,
                hypothesis: m.hypothesis,
                created_at: m.created_at,
                independent_variable_name: m.independent_variable.name,
                bundle_path: path.to_string_lossy().to_string(),
            }),
            Err(e) => {
                tracing::warn!("Skipping unreadable bundle {}: {}", path.display(), e);
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub async fn get_experiment(
    db: State<'_, DatabaseState>,
    id: String,
) -> Result<Experiment, String> {
    let root = project_root(&db)?;
    read_manifest(&bundle_path(&root, &id))
}

#[tauri::command]
pub async fn read_bundle_file(
    db: State<'_, DatabaseState>,
    id: String,
    path: String,
) -> Result<String, String> {
    if !path.starts_with("files/") || path.contains("..") {
        return Err("path must be a 'files/<sha>.<ext>' bundle path".into());
    }
    let root = project_root(&db)?;
    let bundle = bundle_path(&root, &id);
    let bytes = std::fs::read(&bundle).map_err(|e| format!("Failed to read bundle: {}", e))?;
    let mut zip = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut f = zip
        .by_name(&path)
        .map_err(|_| format!("Bundle has no member '{}'", path))?;
    let mut out = String::new();
    f.read_to_string(&mut out).map_err(|e| format!("Failed to read member: {}", e))?;
    Ok(out)
}

// ---------- chat_complete ----------
//
// Wrapper over an OpenAI-compatible /chat/completions endpoint, used by the
// planner UI to drive a multi-turn chat. The renderer holds the full message
// history client-side and re-sends it each turn — no agent-loop state lives
// on the backend.
//
// Implementation: delegates to `aisdk` (Vercel AI SDK port for Rust) so we
// don't maintain hand-rolled HTTP / response-shape / structured-output code
// here. aisdk's `OpenAICompatible<DynamicModel>` provider handles the
// transport; `LanguageModelRequest` handles message threading, temperature,
// and (when supplied) JSON-Schema-based structured output.

use crate::openai_compat::{
    chat_completion, ChatMessage as OcChatMessage, ChatRequest as OcChatRequest,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Returned by `chat_complete`. The renderer parses `content` against the
/// planner-turn schema; `reasoning` is preserved separately so the debug
/// pane can surface chain-of-thought from thinking-capable models.
#[derive(Debug, Serialize)]
pub struct ChatCompleteResult {
    pub content: String,
    pub reasoning: Option<String>,
    pub raw_body: String,
}

#[tauri::command]
pub async fn chat_complete(
    server_url: String,
    model: String,
    messages: Vec<ChatMessage>,
    response_format: Option<serde_json::Value>,
    temperature: Option<f64>,
) -> Result<ChatCompleteResult, String> {
    if url::Url::parse(&server_url).is_err() {
        return Err(format!("Invalid server URL: {}", server_url));
    }
    let oc_messages: Vec<OcChatMessage> = messages
        .into_iter()
        .map(|m| OcChatMessage { role: m.role, content: m.content })
        .collect();
    let req = OcChatRequest {
        model: &model,
        messages: &oc_messages,
        temperature,
        max_tokens: None,
        response_format,
        reasoning_effort: None,
    };
    let outcome = chat_completion(&server_url, &req).await?;
    Ok(ChatCompleteResult {
        content: outcome.content,
        reasoning: outcome.reasoning,
        raw_body: outcome.raw_body,
    })
}

// ---------- generate_experiment_draft ----------
//
// One-shot path: the user describes their experiment in the start-bar
// pitch and we return a populated `Experiment` directly. Skips the
// multi-turn planner-turn schema (`question | freeform | experiment`)
// because local models routinely take the "ask a question" branch even
// when they have everything they need. The system prompt here is laser-
// focused on a single output shape, which removes that failure mode.
//
// Refinement still happens via the existing chat flow afterward — this
// command just gets a usable draft on screen so the user can iterate on
// YAML rather than coax the chatbot through a checklist.

#[derive(Debug, Deserialize)]
pub struct DraftContext {
    pub prompt_files: Vec<String>,
    pub data_files: Vec<String>,
    pub schema_files: Vec<String>,
    pub script_files: Vec<String>,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub default_server_url: Option<String>,
}

fn build_draft_system_prompt(ctx: &DraftContext) -> String {
    let trim = |arr: &[String]| -> String {
        if arr.is_empty() {
            "(none in this project)".to_string()
        } else {
            arr.iter().map(|s| format!("  - {}", s)).collect::<Vec<_>>().join("\n")
        }
    };
    format!(
        "You are designing one experiment for the Nightshift LLM evaluation tool. The user will describe their goal. Your job is to emit a SINGLE JSON object matching this Experiment schema. Output JSON ONLY — no prose, no markdown fences, no explanation.

Schema (omit optional fields when not set):
{{
  \"schema_version\": 1,
  \"id\": \"<short-slug, lowercase, hyphens, no spaces>\",
  \"hypothesis\": \"<the user's goal text — testable hypothesis OR a benchmark/comparison goal; \\\"\\\" allowed>\",
  \"created_at\": \"\",
  \"independent_variable\": {{
    \"name\": \"model\" | \"temperature\" | \"prompt_file\" | \"max_tokens\" | \"system_prompt\",
    \"values\": [<two or more values>]
  }},
  \"controlled_variables\": {{
    \"provider\": \"Local\" | \"OpenAI\" | \"Anthropic\" | \"Google\" | \"Custom\",
    \"model\": \"<string — OMIT this field entirely if independent_variable.name == \\\"model\\\"; required otherwise>\",
    \"server_url\": \"<url>\",
    \"prompt_file\": \"<one of the project's prompt files — OMIT if independent_variable.name == \\\"prompt_file\\\">\",
    \"data_source\": \"<one of the project's data files>\",
    \"output_mode\": \"Unstructured\" | \"Plain JSON\" | \"JSON Schema\",
    \"json_schema_file\": \"<one of the project's schema files, or omit>\",
    \"temperature\": <0.0..=1.0 or omit>,
    \"max_tokens\": <int or omit>,
    \"thinking_budget\": <int or omit>,
    \"samples\": <positive int>,
    \"strategy\": \"single\" | \"random\" | \"exhaustive\"
  }},
  \"trial_template\": {{
    \"nodes\": [
      {{ \"type\": \"inference\", \"id\": \"generate\", \"depends_on\": [] }},
      {{ \"type\": \"transform\", \"id\": \"score\", \"role\": \"eval\",
         \"script_file\": \"<one of the project's transform scripts>\",
         \"error_mode\": \"skip\", \"output_mode\": \"one_to_one\",
         \"depends_on\": [\"generate\"] }}
    ]
  }},
  \"evals\": [{{ \"name\": \"<metric>\", \"source\": \"<node id>\", \"field\": \"<json key>\", \"agg\": \"mean\" | \"sum\" | \"count\" | \"p50\" | \"p95\" }}],
  \"aggregate\": {{ \"group_by\": [\"independent_variable\"], \"metrics\": [\"<metric>\"] }},
  \"analysis_agent\": {{
    \"provider\": \"...\", \"model\": \"...\",
    \"system_prompt_file\": \"<one of the project's prompt files>\",
    \"output_file\": \"analysis.md\"
  }}
}}

Defaults to assume when the user does not specify (use these without asking):
  - provider: \"{provider}\"
  - server_url: \"{server_url}\"
  - model (controlled): \"{model}\"
  - output_mode: \"JSON Schema\" if a json_schema_file is present, else \"Unstructured\"
  - temperature: 0.2
  - max_tokens: 2048
  - samples: 10
  - strategy: \"exhaustive\" if independent_variable.values.len() <= 5 else \"random\"
  - aggregate.group_by: [\"independent_variable\"]
  - analysis_agent.output_file: \"analysis.md\"
  - analysis_agent.provider/model: same as controlled_variables
  - eval field name: best guess from the script's purpose (\"pass\", \"score\", \"success_rate\")

NEVER invent file paths. Pick from these lists:

prompt files:
{prompts}

data files:
{datas}

schema files:
{schemas}

transform scripts:
{scripts}

If a field is genuinely unknown and has no reasonable default, fill it with the closest plausible value from the project context — the user will edit the YAML afterward.

OUTPUT THE JSON OBJECT ONLY.",
        provider = ctx.default_provider.as_deref().unwrap_or("Local"),
        server_url = ctx.default_server_url.as_deref().unwrap_or("http://localhost:1234"),
        model = ctx.default_model.as_deref().unwrap_or(""),
        prompts = trim(&ctx.prompt_files),
        datas = trim(&ctx.data_files),
        schemas = trim(&ctx.schema_files),
        scripts = trim(&ctx.script_files),
    )
}

#[derive(Debug, Serialize)]
pub struct DraftResult {
    pub experiment: Experiment,
    pub raw_body: String,
}

fn strip_code_fences(s: &str) -> &str {
    let t = s.trim();
    let stripped = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    stripped.trim().trim_end_matches("```").trim()
}

#[tauri::command]
pub async fn generate_experiment_draft(
    server_url: String,
    model: String,
    pitch: String,
    context: DraftContext,
) -> Result<DraftResult, String> {
    if pitch.trim().is_empty() {
        return Err("pitch must not be empty".into());
    }
    if url::Url::parse(&server_url).is_err() {
        return Err(format!("Invalid server URL: {}", server_url));
    }

    let system = build_draft_system_prompt(&context);
    let messages = vec![
        crate::openai_compat::ChatMessage { role: "system".into(), content: system },
        crate::openai_compat::ChatMessage { role: "user".into(), content: pitch },
    ];
    let req = crate::openai_compat::ChatRequest {
        model: &model,
        messages: &messages,
        temperature: Some(0.1),
        max_tokens: None,
        response_format: None,
        reasoning_effort: None,
    };
    let outcome = crate::openai_compat::chat_completion(&server_url, &req).await?;
    let raw_content = outcome.content.clone();
    let cleaned = strip_code_fences(&raw_content);
    let experiment: Experiment = serde_json::from_str(cleaned)
        .map_err(|e| format!("Failed to parse draft as Experiment: {} — content was:\n{}", e, raw_content))?;
    Ok(DraftResult { experiment, raw_body: outcome.raw_body })
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sample_experiment(prompt_path: &str, data_path: &str, script_path: &str) -> Experiment {
        Experiment {
            schema_version: 1,
            id: "demo".into(),
            hypothesis: "Bigger model wins".into(),
            created_at: "2026-05-05T00:00:00Z".into(),
            independent_variable: IndependentVariable {
                name: "model".into(),
                values: vec![
                    serde_yaml::Value::String("gpt-4o".into()),
                    serde_yaml::Value::String("gemma4-31b".into()),
                ],
            },
            controlled_variables: ControlledVariables {
                provider: "OpenAI".into(),
                model: Some("gpt-4o".into()),
                server_url: "https://api.openai.com/v1".into(),
                prompt_file: Some(prompt_path.into()),
                data_source: data_path.into(),
                output_mode: "Unstructured".into(),
                json_schema_file: None,
                temperature: Some(0.2),
                max_tokens: None,
                thinking_budget: None,
                samples: 10,
                strategy: "exhaustive".into(),
            },
            trial_template: TrialTemplate {
                nodes: vec![
                    TrialNode::Inference {
                        id: "generate".into(),
                        role: None,
                        prompt_file: None,
                        provider: None,
                        model: None,
                        output_mode: None,
                        json_schema_file: None,
                        depends_on: vec![],
                    },
                    TrialNode::Transform {
                        id: "score".into(),
                        role: Some("eval".into()),
                        script_file: script_path.into(),
                        error_mode: "skip".into(),
                        output_mode: "one_to_one".into(),
                        depends_on: vec!["generate".into()],
                    },
                ],
            },
            evals: vec![EvalMetric {
                name: "pass_rate".into(),
                source: "score".into(),
                field: "pass".into(),
                agg: "mean".into(),
            }],
            aggregate: Aggregate {
                group_by: vec!["independent_variable".into()],
                metrics: vec!["pass_rate".into()],
            },
            analysis_agent: AnalysisAgent {
                provider: "OpenAI".into(),
                model: "gpt-4o".into(),
                system_prompt_file: prompt_path.into(),
                output_file: "analysis.md".into(),
            },
        }
    }

    #[test]
    fn validate_rejects_unknown_iv_name() {
        let mut e = sample_experiment("p.jinja2", "d.jsonl", "s.js");
        e.independent_variable.name = "bogus".into();
        assert!(validate(&e).is_err());
    }

    #[test]
    fn validate_rejects_duplicate_iv_values() {
        let mut e = sample_experiment("p.jinja2", "d.jsonl", "s.js");
        e.independent_variable.values =
            vec![serde_yaml::Value::String("a".into()), serde_yaml::Value::String("a".into())];
        assert!(validate(&e).is_err());
    }

    #[test]
    fn validate_allows_missing_model_when_iv_is_model() {
        let mut e = sample_experiment("p.jinja2", "d.jsonl", "s.js");
        e.independent_variable.name = "model".into();
        e.controlled_variables.model = None;
        // Pre-conditions: IV name "model" + values intact from the helper.
        assert!(validate(&e).is_ok());
    }

    #[test]
    fn validate_requires_model_when_iv_is_not_model() {
        let mut e = sample_experiment("p.jinja2", "d.jsonl", "s.js");
        e.independent_variable.name = "temperature".into();
        e.independent_variable.values = vec![
            serde_yaml::Value::Number(serde_yaml::Number::from(0.1)),
            serde_yaml::Value::Number(serde_yaml::Number::from(0.7)),
        ];
        e.controlled_variables.model = None;
        let err = validate(&e).unwrap_err();
        assert!(err.contains("controlled_variables.model"));
    }

    #[test]
    fn validate_rejects_unknown_dependency() {
        let mut e = sample_experiment("p.jinja2", "d.jsonl", "s.js");
        if let TrialNode::Transform { depends_on, .. } = &mut e.trial_template.nodes[1] {
            depends_on.push("ghost".into());
        }
        assert!(validate(&e).is_err());
    }

    #[test]
    fn validate_rejects_cycle() {
        let mut e = sample_experiment("p.jinja2", "d.jsonl", "s.js");
        if let TrialNode::Inference { depends_on, .. } = &mut e.trial_template.nodes[0] {
            depends_on.push("score".into());
        }
        assert!(validate(&e).is_err());
    }

    #[test]
    fn snapshot_dedups_identical_files_and_rewrites_paths() {
        let tmp = std::env::temp_dir().join(format!("ns_exp_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        // Two paths, same content → should yield the same sha (one zip member).
        fs::write(tmp.join("a.jinja2"), "hello").unwrap();
        fs::write(tmp.join("b.jsonl"), "hello").unwrap(); // identical bytes
        fs::write(tmp.join("s.js"), "x => x").unwrap();

        // Two identical-content files with the same extension dedup to one
        // zip member; identical content with a different extension does not
        // (we key by content+ext so the bundle keeps `.jsonl` data files
        // distinguishable from `.jinja2` prompts on disk).
        let mut e = sample_experiment("a.jinja2", "b.jsonl", "s.js");
        e.analysis_agent.system_prompt_file = "a.jinja2".into();

        let buf = Cursor::new(Vec::<u8>::new());
        let mut zip = ZipWriter::new(buf);
        snapshot_all_files(&mut e, &tmp, &mut zip).unwrap();
        let bytes = zip.finish().unwrap().into_inner();

        // prompt_file and analysis_agent.system_prompt_file are both .jinja2
        // with identical content → same bundle path.
        let prompt_path = e.controlled_variables.prompt_file.as_deref().unwrap();
        assert_eq!(prompt_path, e.analysis_agent.system_prompt_file);
        assert!(prompt_path.starts_with("files/"));
        // data_source has the same bytes but a .jsonl extension → distinct.
        assert_ne!(prompt_path, e.controlled_variables.data_source);

        // Three distinct (content, ext) pairs in this experiment:
        //   1. hello+jinja2 (prompt_file == analysis system prompt)
        //   2. hello+jsonl (data_source)
        //   3. "x => x"+js (transform script)
        let archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let names: Vec<&str> = archive.file_names().collect();
        let file_members: Vec<_> = names.iter().filter(|n| n.starts_with("files/")).collect();
        assert_eq!(file_members.len(), 3, "expected 3 unique snapshot files, got {:?}", names);

        fs::remove_dir_all(&tmp).ok();
    }

    // (URL-normalization tests now live in `crate::openai_compat::tests`.)
}
