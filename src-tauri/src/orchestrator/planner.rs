//! `Planner` — LLM-backed decomposition of an experiment's definition tree.
//!
//! Runs once per `experiment_start` for group-rooted experiments. Single-leaf
//! roots skip the planner entirely (nothing to decompose). The planner reads
//! the current tree, asks an LLM to produce a structured plan, validates the
//! output against an in-code JSON schema, then writes the plan to the root
//! execution's `plan` column and seeds initial ledger entries.
//!
//! Per scope, this is a *single* planning pass. Re-plan, stuck-detection, and
//! supersedence land in a future phase.
//!
//! The planner is intentionally fault-tolerant: if the LLM is unreachable,
//! returns invalid JSON, or is explicitly disabled via
//! `params.plan_disabled = true`, the planner stores an empty plan and lets
//! the experiment proceed using the user's tree as authored. This keeps runs
//! deterministic in dev/tests where no LLM is configured.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use crate::database::DatabaseState;
use crate::orchestrator::definition_service::{DefinitionService, JobDefinitionVersion};
use crate::orchestrator::llm::{self, LlmCallOptions};

const DEFAULT_PLANNER_MODEL: &str = "gpt-5-nano";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPhase {
    pub name: String,
    #[serde(default)]
    pub definition_ids: Vec<i64>,
    #[serde(default)]
    pub success_criteria: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub phases: Vec<PlanPhase>,
    pub expected_step_count: i64,
    /// Set when the planner produced no LLM-driven plan (disabled or
    /// unreachable). The orchestrator runs the user-authored tree as-is.
    #[serde(default)]
    pub source: Option<String>,
}

impl Plan {
    pub fn empty(reason: &str) -> Self {
        Self {
            phases: Vec::new(),
            expected_step_count: 0,
            source: Some(reason.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct LedgerEntry {
    timestamp: String,
    kind: &'static str,
    message: String,
}

pub struct Planner {
    db: DatabaseState,
    http: Client,
}

impl Planner {
    pub fn new(db: DatabaseState, http: Client) -> Self {
        Self { db, http }
    }

    /// Plan the experiment and write `plan` + initial `ledger` to the root
    /// execution row. Returns the plan written. Errors are logged but do not
    /// fail the run — the orchestrator falls back to the user's tree.
    pub async fn plan(
        &self,
        root_def_id: i64,
        root_exec_id: i64,
        defs: &DefinitionService,
    ) -> Plan {
        let plan = match self.try_plan(root_def_id, root_exec_id, defs).await {
            Ok(p) => p,
            Err(e) => {
                warn!(root_exec_id, error = %e, "planner failed; falling back to empty plan");
                Plan::empty(&format!("planner-failed: {}", e))
            }
        };

        if let Err(e) = self.persist_plan(root_exec_id, &plan).await {
            warn!(root_exec_id, error = %e, "failed to persist plan");
        }
        plan
    }

    async fn try_plan(
        &self,
        root_def_id: i64,
        root_exec_id: i64,
        defs: &DefinitionService,
    ) -> Result<Plan, String> {
        let dv = defs
            .read_current(root_def_id)
            .await
            .map_err(|e| format!("read root: {}", e))?;
        let Some(version) = dv.version else {
            return Err("root definition has no current version".into());
        };

        // Single-leaf roots have nothing to decompose. Seed an empty plan and
        // a single ledger entry noting the run shape.
        if version.kind != "group" {
            return Ok(Plan {
                phases: vec![PlanPhase {
                    name: "execute".into(),
                    definition_ids: vec![root_def_id],
                    success_criteria: Some(format!(
                        "{} leaf completes successfully",
                        version.kind
                    )),
                }],
                expected_step_count: 1,
                source: Some("single-leaf".into()),
            });
        }

        // Optional escape hatch for tests / dev-without-LLM.
        if planner_disabled(&version) {
            return Ok(Plan::empty("disabled-via-params"));
        }

        let model = planner_model(&version);
        let server_url = planner_server_url(&version);
        let provider = planner_provider(&version);

        let tree_summary = self.collect_tree_summary(root_def_id, defs).await?;
        let prompt = build_planner_prompt(&tree_summary);

        let opts = LlmCallOptions {
            provider: &provider,
            server_url: &server_url,
            model: &model,
            temperature: Some(0.2),
            max_tokens: Some(2048),
            thinking_budget: None,
            response_format: Some(plan_response_format()),
        };

        info!(root_exec_id, model, "invoking planner LLM");
        let outcome = llm::attempt_llm_call_with_retry(&self.http, prompt, &opts, 1)
            .await
            .map_err(|e| format!("LLM call failed: {}", e))?;

        let raw = outcome.content.trim();
        let parsed: Plan = serde_json::from_str(raw)
            .map_err(|e| format!("planner output not valid Plan JSON: {}; raw: {}", e, raw))?;
        Ok(parsed)
    }

    async fn collect_tree_summary(
        &self,
        root_def_id: i64,
        defs: &DefinitionService,
    ) -> Result<Vec<TreeNodeSummary>, String> {
        let all = defs
            .list_by_root(root_def_id)
            .await
            .map_err(|e| format!("list_by_root: {}", e))?;
        let mut out = Vec::with_capacity(all.len());
        for d in all {
            let dv = defs
                .read_current(d.id)
                .await
                .map_err(|e| format!("read_current({}): {}", d.id, e))?;
            out.push(TreeNodeSummary {
                id: d.id,
                parent_id: d.parent_id,
                name: d.name.clone(),
                kind: dv.version.as_ref().map(|v| v.kind.clone()).unwrap_or_else(|| "unsaved".into()),
                description: dv.version.as_ref().and_then(|v| v.description.clone()),
            });
        }
        Ok(out)
    }

    async fn persist_plan(&self, root_exec_id: i64, plan: &Plan) -> Result<(), sqlx::Error> {
        let plan_json = serde_json::to_string(plan).expect("Plan is always serializable");
        let now = chrono_now();
        let ledger = vec![LedgerEntry {
            timestamp: now,
            kind: "plan_seeded",
            message: format!(
                "Planner seeded {} phase(s); expected step count={}",
                plan.phases.len(),
                plan.expected_step_count
            ),
        }];
        let ledger_json =
            serde_json::to_string(&ledger).expect("ledger is always serializable");

        sqlx::query("UPDATE job_execution SET plan = ?, ledger = ? WHERE id = ?")
            .bind(plan_json)
            .bind(ledger_json)
            .bind(root_exec_id)
            .execute(&self.db.pool())
            .await?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
struct TreeNodeSummary {
    id: i64,
    parent_id: Option<i64>,
    name: String,
    kind: String,
    description: Option<String>,
}

fn planner_disabled(version: &JobDefinitionVersion) -> bool {
    serde_json::from_str::<Value>(&version.params)
        .ok()
        .and_then(|v| v.get("plan_disabled").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn planner_model(version: &JobDefinitionVersion) -> String {
    serde_json::from_str::<Value>(&version.params)
        .ok()
        .and_then(|v| v.get("planner_model").and_then(|s| s.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| DEFAULT_PLANNER_MODEL.to_string())
}

fn planner_server_url(version: &JobDefinitionVersion) -> String {
    serde_json::from_str::<Value>(&version.params)
        .ok()
        .and_then(|v| v.get("planner_server_url").and_then(|s| s.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "https://api.openai.com".to_string())
}

fn planner_provider(version: &JobDefinitionVersion) -> String {
    serde_json::from_str::<Value>(&version.params)
        .ok()
        .and_then(|v| v.get("planner_provider").and_then(|s| s.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "openai".to_string())
}

fn build_planner_prompt(tree: &[TreeNodeSummary]) -> String {
    let tree_json = serde_json::to_string_pretty(tree).expect("tree summary serializable");
    format!(
        "You are an experiment planner. Given the user's experiment definition tree below,\n\
         output a JSON plan describing the order of execution and success criteria for each\n\
         logical phase. Phases group related leaf definitions; the same definition may appear\n\
         in only one phase.\n\n\
         Definition tree:\n{}\n\n\
         Output JSON of the form:\n\
         {{\n  \"phases\": [{{ \"name\": \"<short>\", \"definition_ids\": [...], \"success_criteria\": \"<short>\" }}, ...],\n  \"expected_step_count\": <int>\n}}\n",
        tree_json
    )
}

fn plan_response_format() -> serde_json::Value {
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": "experiment_plan",
            "strict": true,
            "schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["phases", "expected_step_count"],
                "properties": {
                    "phases": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["name", "definition_ids", "success_criteria"],
                            "properties": {
                                "name": {"type": "string"},
                                "definition_ids": {"type": "array", "items": {"type": "integer"}},
                                "success_criteria": {"type": "string"}
                            }
                        }
                    },
                    "expected_step_count": {"type": "integer"}
                }
            }
        }
    })
}

fn chrono_now() -> String {
    // SQLite's CURRENT_TIMESTAMP format: 'YYYY-MM-DD HH:MM:SS'. Rust's
    // `time` crate isn't a dep here so format manually from system time.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let secs = now.as_secs();
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

/// Tiny UTC unix-seconds-to-(Y,M,D,H,M,S) breakdown — avoids adding a date
/// dep just for ledger timestamps. Good through year 2099.
fn unix_to_ymdhms(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let mut days = secs / 86_400;
    let mut year: u64 = 1970;
    loop {
        let leap = is_leap(year);
        let dy: u64 = if leap { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let mdays: [u64; 12] = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    (year, (month + 1) as u64, days + 1, h, m, s)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_plan_carries_source_reason() {
        let p = Plan::empty("disabled-via-params");
        assert_eq!(p.expected_step_count, 0);
        assert_eq!(p.phases.len(), 0);
        assert_eq!(p.source.as_deref(), Some("disabled-via-params"));
    }

    #[test]
    fn unix_to_ymdhms_handles_known_timestamps() {
        // 2026-01-01 00:00:00 UTC = 1767225600
        let (y, mo, d, h, mi, s) = unix_to_ymdhms(1_767_225_600);
        assert_eq!((y, mo, d, h, mi, s), (2026, 1, 1, 0, 0, 0));
    }
}
