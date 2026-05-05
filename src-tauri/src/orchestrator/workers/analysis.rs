//! `AnalysisWorker` — runs an analysis-agent leaf.
//!
//! v1 is a single-pass "summarize then write" loop: read the upstream
//! collections (resolved via sibling/siblings/concat/static input_ref kinds),
//! summarize them into a structured prompt, ask an LLM for a markdown
//! analysis, write it to a project-relative output path, and append ledger
//! entries at each step.
//!
//! The full bounded multi-turn tool surface (list_tables / describe_table /
//! query / check_query / fetch_excerpt / write_section, with 5 SQL turns +
//! 1 revision pass) is the design end state. P0 ships the happy path: one
//! LLM call producing the analysis directly. Workers are stateless so the
//! richer loop can land as a drop-in replacement of `execute_inner`.

use std::path::PathBuf;
use std::pin::Pin;
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use tracing::{info, warn};

use crate::orchestrator::definition_service::JobDefinitionVersion;
use crate::orchestrator::execution::{ExecutionService, JobExecution};
use crate::orchestrator::llm::{
    self, resolve_within_project, LlmCallOptions,
};
use crate::orchestrator::resolver::{parse_input_ref, InputRef};

use super::{Worker, WorkerContext, WorkerError};

const MAX_PREVIEW_ROWS: usize = 20;

#[derive(Debug, Clone, Serialize)]
struct ExecutionStatusPayload {
    #[serde(rename = "execId")]
    exec_id: i64,
    status: &'static str,
    #[serde(rename = "parentId")]
    parent_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LedgerEntry {
    timestamp: String,
    kind: &'static str,
    message: String,
}

#[derive(Debug, Clone)]
struct AnalysisParams {
    output_path: String,
    provider: String,
    server_url: String,
    model: String,
    /// Optional override; the worker uses `analysis_prompt` for the user
    /// instructions if provided, otherwise a default summarization prompt.
    instructions: Option<String>,
}

fn parse_analysis_params(version: &JobDefinitionVersion) -> Result<AnalysisParams, WorkerError> {
    let v: Value = serde_json::from_str(&version.params)
        .map_err(|e| WorkerError::InvalidConfig(format!("params not JSON: {}", e)))?;
    let obj = v
        .as_object()
        .ok_or_else(|| WorkerError::InvalidConfig("params must be an object".into()))?;
    let output_path = obj
        .get("output_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| WorkerError::InvalidConfig("params.output_path required".into()))?;
    let provider = obj
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("openai")
        .to_string();
    let server_url = obj
        .get("server_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://api.openai.com")
        .to_string();
    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("gpt-5-nano")
        .to_string();
    let instructions = obj
        .get("instructions")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(AnalysisParams { output_path, provider, server_url, model, instructions })
}

#[derive(Default)]
pub struct AnalysisWorker;

impl AnalysisWorker {
    pub fn new() -> Self {
        Self
    }

    async fn execute_inner(
        &self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> Result<(), WorkerError> {
        if version.kind != "analysis" {
            return Err(WorkerError::InvalidConfig(format!(
                "AnalysisWorker invoked for kind={}",
                version.kind
            )));
        }
        let params = parse_analysis_params(&version)?;
        let exec_svc = ExecutionService::new(ctx.db.clone());
        let mut ledger: Vec<LedgerEntry> = Vec::new();

        exec_svc.mark_running(exec.id).await?;
        ctx.emit(
            "execution-status",
            ExecutionStatusPayload {
                exec_id: exec.id,
                status: "running",
                parent_id: exec.parent_id,
                error: None,
            },
        );

        let pool = ctx.db.pool();

        // Resolve input collections — analysis treats sibling/siblings/static
        // specially (it wants the collection ids, not row streams).
        let input_ref_value: Value = match version.input_ref.as_deref() {
            Some(s) => serde_json::from_str(s).map_err(|e| {
                WorkerError::InvalidConfig(format!("input_ref not JSON: {}", e))
            })?,
            None => Value::Null,
        };
        let collection_ids =
            resolve_collection_ids(&pool, &input_ref_value, &exec, &version).await?;

        self.append_ledger(
            &pool,
            exec.id,
            &mut ledger,
            "queries",
            &format!("identified {} input collection(s)", collection_ids.len()),
            &ctx,
        )
        .await?;

        // Pull a sample of rows from each input collection for the prompt.
        let mut anecdotes: Vec<(i64, Vec<Value>)> = Vec::new();
        for cid in &collection_ids {
            let rows = sample_collection(&pool, *cid, MAX_PREVIEW_ROWS).await?;
            anecdotes.push((*cid, rows));
        }
        self.append_ledger(
            &pool,
            exec.id,
            &mut ledger,
            "anecdotes",
            &format!(
                "sampled {} rows total across collections",
                anecdotes.iter().map(|(_, r)| r.len()).sum::<usize>()
            ),
            &ctx,
        )
        .await?;

        // Build the prompt and ask the LLM to draft the markdown analysis.
        let prompt = build_prompt(&params, &collection_ids, &anecdotes);
        let opts = LlmCallOptions {
            provider: &params.provider,
            server_url: &params.server_url,
            model: &params.model,
            temperature: Some(0.3),
            max_tokens: Some(4096),
            thinking_budget: None,
            response_format: None,
        };
        let outcome = match llm::attempt_llm_call_with_retry(&ctx.http, prompt, &opts, 1).await {
            Ok(o) => o,
            Err(e) => {
                let msg = format!("analysis LLM call failed: {}", e);
                exec_svc.mark_failed(exec.id, &msg).await?;
                ctx.emit(
                    "execution-status",
                    ExecutionStatusPayload {
                        exec_id: exec.id,
                        status: "failed",
                        parent_id: exec.parent_id,
                        error: Some(msg.clone()),
                    },
                );
                return Err(WorkerError::Failed(msg));
            }
        };

        self.append_ledger(
            &pool,
            exec.id,
            &mut ledger,
            "draft",
            &format!("drafted {} characters of analysis", outcome.content.len()),
            &ctx,
        )
        .await?;

        // Write the markdown to the project-relative output path.
        match write_output(&ctx.project_root, &params.output_path, &outcome.content).await {
            Ok(full_path) => {
                self.append_ledger(
                    &pool,
                    exec.id,
                    &mut ledger,
                    "write_section",
                    &format!("wrote analysis to {}", full_path.display()),
                    &ctx,
                )
                .await?;
            }
            Err(e) => {
                let msg = format!("failed to write analysis: {}", e);
                exec_svc.mark_failed(exec.id, &msg).await?;
                return Err(WorkerError::Failed(msg));
            }
        }

        // Materialize a leaf collection so downstream consumers can find
        // analysis output via the same execution_id → collection mapping
        // every other worker uses. The single row holds the markdown.
        let collection_id: i64 = sqlx::query_scalar(
            "INSERT INTO collection (execution_id, definition_id, name) \
             VALUES (?, ?, ?) RETURNING id",
        )
        .bind(exec.id)
        .bind(version.definition_id)
        .bind(format!("analysis-{}", exec.id))
        .fetch_one(&pool)
        .await?;
        let data = serde_json::json!({
            "output_path": params.output_path,
            "content": outcome.content,
            "model": params.model,
        });
        sqlx::query(
            "INSERT INTO collection_item \
                (collection_id, item_index, status, data, finished_at, updated_at) \
             VALUES (?, 0, 'completed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        )
        .bind(collection_id)
        .bind(serde_json::to_string(&data).expect("serializable"))
        .execute(&pool)
        .await?;

        exec_svc.mark_completed(exec.id).await?;
        ctx.emit(
            "execution-status",
            ExecutionStatusPayload {
                exec_id: exec.id,
                status: "completed",
                parent_id: exec.parent_id,
                error: None,
            },
        );
        info!(exec_id = exec.id, "analysis completed");
        Ok(())
    }

    async fn append_ledger(
        &self,
        pool: &sqlx::SqlitePool,
        exec_id: i64,
        ledger: &mut Vec<LedgerEntry>,
        kind: &'static str,
        message: &str,
        ctx: &WorkerContext,
    ) -> Result<(), sqlx::Error> {
        ledger.push(LedgerEntry {
            timestamp: now_iso(),
            kind,
            message: message.to_string(),
        });
        let payload = serde_json::to_string(ledger).expect("ledger serializable");
        sqlx::query("UPDATE job_execution SET ledger = ? WHERE id = ?")
            .bind(&payload)
            .bind(exec_id)
            .execute(pool)
            .await?;
        ctx.emit(
            "execution-ledger-updated",
            serde_json::json!({"execId": exec_id, "entryCount": ledger.len()}),
        );
        Ok(())
    }
}

impl Worker for AnalysisWorker {
    fn execute<'a>(
        &'a self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), WorkerError>> + Send + 'a>> {
        Box::pin(self.execute_inner(exec, version, ctx))
    }
}

/// Find collection ids implied by the input_ref. Static / sibling / siblings
/// / concat all reduce to a flat list of completed-collection ids in the
/// current run. File / grid have no collections to return.
async fn resolve_collection_ids(
    pool: &sqlx::SqlitePool,
    input_ref_value: &Value,
    exec: &JobExecution,
    version: &JobDefinitionVersion,
) -> Result<Vec<i64>, WorkerError> {
    if input_ref_value.is_null() {
        return Ok(Vec::new());
    }
    let ir = parse_input_ref(input_ref_value).map_err(WorkerError::InvalidConfig)?;
    let parent_def_row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT parent_id FROM job_definition WHERE id = ?")
            .bind(version.definition_id)
            .fetch_optional(pool)
            .await?;
    let parent_def_id = parent_def_row.and_then(|(p,)| p).unwrap_or(0);
    collect_ids(pool, &ir, parent_def_id, exec.root_id).await
}

fn collect_ids<'a>(
    pool: &'a sqlx::SqlitePool,
    ir: &'a InputRef,
    parent_def_id: i64,
    root_exec_id: i64,
) -> Pin<Box<dyn std::future::Future<Output = Result<Vec<i64>, WorkerError>> + Send + 'a>> {
    Box::pin(async move {
        match ir {
            InputRef::Static { collection_id } => Ok(vec![*collection_id]),
            InputRef::Sibling { name } => {
                let opt = crate::orchestrator::resolver::find_sibling_collection(
                    pool,
                    parent_def_id,
                    name,
                    root_exec_id,
                )
                .await
                .map_err(|e| WorkerError::Failed(format!("sibling lookup: {}", e)))?;
                Ok(opt.into_iter().collect())
            }
            InputRef::Siblings { names } => {
                let mut out = Vec::with_capacity(names.len());
                for name in names {
                    if let Some(cid) = crate::orchestrator::resolver::find_sibling_collection(
                        pool,
                        parent_def_id,
                        name,
                        root_exec_id,
                    )
                    .await
                    .map_err(|e| WorkerError::Failed(format!("siblings lookup: {}", e)))?
                    {
                        out.push(cid);
                    } else {
                        warn!(
                            name = %name,
                            "sibling for analysis input has no completed collection in this run"
                        );
                    }
                }
                Ok(out)
            }
            InputRef::Concat { sources } => {
                let mut out = Vec::new();
                for src in sources {
                    let chunk = collect_ids(pool, src, parent_def_id, root_exec_id).await?;
                    out.extend(chunk);
                }
                Ok(out)
            }
            // file / grid produce rows, not collection ids — analysis ignores them.
            InputRef::File { .. } | InputRef::Grid { .. } => Ok(Vec::new()),
        }
    })
}

async fn sample_collection(
    pool: &sqlx::SqlitePool,
    collection_id: i64,
    limit: usize,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT data FROM collection_item \
         WHERE collection_id = ? AND status = 'completed' \
         ORDER BY item_index ASC LIMIT ?",
    )
    .bind(collection_id)
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let data: Option<String> = row.try_get("data")?;
        if let Some(s) = data {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                out.push(v);
            }
        }
    }
    Ok(out)
}

fn build_prompt(
    params: &AnalysisParams,
    collection_ids: &[i64],
    anecdotes: &[(i64, Vec<Value>)],
) -> String {
    let instructions = params.instructions.as_deref().unwrap_or(
        "Summarize the patterns in the upstream collections below into a concise \
         markdown report. Note any failures or anomalies. Keep it under 800 words.",
    );
    let anecdote_blob = anecdotes
        .iter()
        .map(|(cid, rows)| {
            let body = serde_json::to_string_pretty(rows)
                .unwrap_or_else(|_| "[]".into());
            format!("## Collection {}\n```json\n{}\n```\n", cid, body)
        })
        .collect::<String>();
    format!(
        "{instructions}\n\nInput collections: {ids:?}\n\n{body}",
        instructions = instructions,
        ids = collection_ids,
        body = anecdote_blob,
    )
}

async fn write_output(
    project_root: &std::path::Path,
    output_path: &str,
    content: &str,
) -> Result<PathBuf, String> {
    // Validate it's safely inside the project root, then ensure parent dirs
    // exist before writing. If the file doesn't exist yet, `resolve_within_project`
    // would fail on canonicalization; do a manual safety check instead.
    use std::path::{Component, Path};
    let path = Path::new(output_path);
    if path.is_absolute() {
        return Err(format!("output_path must be project-relative: {}", output_path));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("output_path may not contain '..': {}", output_path));
    }
    let root_canonical = std::fs::canonicalize(project_root)
        .map_err(|e| format!("project root unresolvable: {}", e))?;
    let target = root_canonical.join(path);
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create dir {}: {}", parent.display(), e))?;
    }
    tokio::fs::write(&target, content)
        .await
        .map_err(|e| format!("failed to write {}: {}", target.display(), e))?;
    // Now that the file exists, sanity-check it's still inside the root.
    let _safe = resolve_within_project(&root_canonical, output_path)?;
    Ok(target)
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

fn unix_to_ymdhms(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let mut days = secs / 86_400;
    let mut year: u64 = 1970;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let dy: u64 = if leap { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let mdays: [u64; 12] = if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
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
