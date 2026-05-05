//! `InferenceWorker` — executes a `kind=inference` leaf. For each input row
//! resolved from the version's `input_ref`, render the prompt template, call
//! the LLM, and write a `collection_item_v2` row with full per-row execution
//! state (status, attempt, backend, tokens, latency, error). Refactor of the
//! legacy `JobExecutor::execute_job` body for the orchestrator path.

use std::pin::Pin;

use rand::seq::SliceRandom;
use serde::Serialize;
use serde_json::Value;
use tracing::{debug, error, info, warn};

use crate::orchestrator::definition_service::JobDefinitionVersion;
use crate::orchestrator::execution::{ExecutionService, JobExecution};
use crate::orchestrator::llm::{
    self, LlmCallOptions,
};
use crate::orchestrator::resolver::{self, parse_input_ref, ResolveContext};

use super::{Worker, WorkerContext, WorkerError};

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
struct ExecutionProgressPayload {
    #[serde(rename = "execId")]
    exec_id: i64,
    completed: i64,
    failed: i64,
    total: i64,
}

#[derive(Debug, Clone)]
struct InferenceParams {
    prompt_file: String,
    provider: String,
    model: String,
    server_url: String,
    output_mode: String,
    temperature: Option<f64>,
    max_tokens: Option<i32>,
    thinking_budget: Option<i32>,
    samples: i32,
    strategy: String,
    json_schema_file: Option<String>,
}

fn parse_params(version: &JobDefinitionVersion) -> Result<InferenceParams, WorkerError> {
    let v: Value = serde_json::from_str(&version.params)
        .map_err(|e| WorkerError::InvalidConfig(format!("params not valid JSON: {}", e)))?;
    let obj = v
        .as_object()
        .ok_or_else(|| WorkerError::InvalidConfig("params must be an object".into()))?;

    fn get_str(obj: &serde_json::Map<String, Value>, key: &str) -> Result<String, WorkerError> {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| WorkerError::InvalidConfig(format!("params.{} missing or not a string", key)))
    }
    fn opt_str(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
        obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    }
    fn opt_i32(obj: &serde_json::Map<String, Value>, key: &str) -> Option<i32> {
        obj.get(key).and_then(|v| v.as_i64()).map(|n| n as i32)
    }
    fn opt_f64(obj: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
        obj.get(key).and_then(|v| v.as_f64())
    }

    Ok(InferenceParams {
        prompt_file: get_str(obj, "prompt_file")?,
        provider: get_str(obj, "provider")?,
        model: get_str(obj, "model")?,
        server_url: get_str(obj, "server_url")?,
        output_mode: get_str(obj, "output_mode")?,
        temperature: opt_f64(obj, "temperature"),
        max_tokens: opt_i32(obj, "max_tokens"),
        thinking_budget: opt_i32(obj, "thinking_budget"),
        samples: opt_i32(obj, "samples").unwrap_or(1),
        strategy: opt_str(obj, "strategy").unwrap_or_else(|| "single".into()),
        json_schema_file: opt_str(obj, "json_schema_file"),
    })
}

/// Apply the user's sampling strategy to the resolved input rows.
/// Single = first row only. Random = `samples` rows shuffled. Exhaustive =
/// every row repeated `samples` times. Mirrors legacy semantics verbatim.
fn apply_strategy(rows: Vec<Value>, strategy: &str, samples: i32) -> Vec<Value> {
    match strategy.to_lowercase().as_str() {
        "single" => rows.into_iter().next().map(|s| vec![s]).unwrap_or_default(),
        "random" => {
            let count = (samples.max(0) as usize).min(rows.len());
            if count == 0 || rows.is_empty() {
                return Vec::new();
            }
            let mut rng = rand::rng();
            let mut indices: Vec<usize> = (0..rows.len()).collect();
            indices.shuffle(&mut rng);
            indices.into_iter().take(count).map(|i| rows[i].clone()).collect()
        }
        _ => {
            // exhaustive (default for unknown values)
            let reps = if samples > 1 { samples as usize } else { 1 };
            let mut out = Vec::with_capacity(rows.len() * reps);
            for s in rows {
                for _ in 0..reps {
                    out.push(s.clone());
                }
            }
            out
        }
    }
}

#[derive(Default)]
pub struct InferenceWorker;

impl InferenceWorker {
    pub fn new() -> Self {
        Self
    }

    async fn execute_inner(
        &self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> Result<(), WorkerError> {
        let exec_id = exec.id;
        let exec_svc = ExecutionService::new(ctx.db.clone());

        // Pre-flight: kind must be inference. Other kinds shouldn't reach this
        // worker but check defensively.
        if version.kind != "inference" {
            return Err(WorkerError::InvalidConfig(format!(
                "InferenceWorker invoked for kind={}",
                version.kind
            )));
        }

        let params = parse_params(&version)?;

        let input_ref_value: Value = match version.input_ref.as_deref() {
            Some(s) => serde_json::from_str(s).map_err(|e| {
                WorkerError::InvalidConfig(format!("input_ref not valid JSON: {}", e))
            })?,
            None => {
                return Err(WorkerError::InvalidConfig("input_ref is required for inference".into()));
            }
        };
        let input_ref = parse_input_ref(&input_ref_value).map_err(WorkerError::InvalidConfig)?;

        // Sibling/concat resolution needs the current definition's parent_id
        // (so we look up peers under the same group) and the run's root
        // execution id. File / static / grid don't use these but the resolver
        // takes them uniformly.
        let pool = ctx.db.pool();
        let parent_def_row: Option<(Option<i64>,)> =
            sqlx::query_as("SELECT parent_id FROM job_definition WHERE id = ?")
                .bind(version.definition_id)
                .fetch_optional(&pool)
                .await?;
        let parent_def_id = parent_def_row.and_then(|(p,)| p).unwrap_or(0);
        let resolve_ctx = ResolveContext {
            project_root: &ctx.project_root,
            pool: &pool,
            parent_def_id,
            root_exec_id: exec.root_id,
        };
        let resolved =
            resolver::resolve(&resolve_ctx, &input_ref).await.map_err(WorkerError::Failed)?;
        let rows = apply_strategy(resolved, &params.strategy, params.samples);
        let total = rows.len() as i64;

        info!(exec_id, count = total, "InferenceWorker resolved input rows");

        // Mark the execution running and emit status.
        exec_svc.mark_running(exec_id).await?;
        ctx.emit(
            "execution-status",
            ExecutionStatusPayload {
                exec_id,
                status: "running",
                parent_id: exec.parent_id,
                error: None,
            },
        );

        // Create the execution-scoped collection. Definition id comes from the
        // version row.
        let pool = ctx.db.pool();
        let collection_id: i64 = sqlx::query_scalar(
            "INSERT INTO collection_v2 (execution_id, definition_id, name) \
             VALUES (?, ?, ?) RETURNING id",
        )
        .bind(exec_id)
        .bind(version.definition_id)
        .bind(format!("execution-{} outputs", exec_id))
        .fetch_one(&pool)
        .await?;

        // Pre-insert pending rows so the UI sees the full count immediately.
        for (idx, _) in rows.iter().enumerate() {
            sqlx::query(
                "INSERT INTO collection_item_v2 (collection_id, item_index, status) \
                 VALUES (?, ?, 'pending')",
            )
            .bind(collection_id)
            .bind(idx as i64)
            .execute(&pool)
            .await?;
        }

        // Pre-load the prompt + response_format once; they're shared per-row.
        let prompt_template = llm::load_prompt_file(&ctx.project_root, &params.prompt_file)
            .await
            .map_err(WorkerError::Failed)?;
        let response_format = llm::build_response_format(
            &ctx.project_root,
            &params.output_mode,
            params.json_schema_file.as_deref(),
        )
        .await
        .map_err(WorkerError::Failed)?;

        let opts = LlmCallOptions {
            provider: &params.provider,
            server_url: &params.server_url,
            model: &params.model,
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            thinking_budget: params.thinking_budget,
            response_format,
        };

        let mut completed = 0i64;
        let mut failed = 0i64;
        let mut last_error: Option<String> = None;

        for (idx, row) in rows.iter().enumerate() {
            // Cooperative cancellation between rows.
            if exec_svc.is_cancellation_requested(exec.root_id).await? {
                info!(exec_id, "cancellation requested, stopping inference loop");
                exec_svc.mark_cancelled(exec_id).await?;
                ctx.emit(
                    "execution-status",
                    ExecutionStatusPayload {
                        exec_id,
                        status: "cancelled",
                        parent_id: exec.parent_id,
                        error: None,
                    },
                );
                return Err(WorkerError::Cancelled);
            }

            sqlx::query(
                "UPDATE collection_item_v2 \
                 SET status = 'running', started_at = CURRENT_TIMESTAMP, attempt = attempt + 1 \
                 WHERE collection_id = ? AND item_index = ?",
            )
            .bind(collection_id)
            .bind(idx as i64)
            .execute(&pool)
            .await?;

            let rendered = match llm::render_prompt(&prompt_template, row) {
                Ok(s) => s,
                Err(e) => {
                    record_failure(&pool, collection_id, idx as i64, &e).await?;
                    failed += 1;
                    last_error = Some(e);
                    emit_progress(&ctx, exec_id, completed, failed, total);
                    continue;
                }
            };

            match llm::attempt_llm_call_with_retry(&ctx.http, rendered, &opts, 3).await {
                Ok(out) => {
                    let data = serde_json::json!({
                        "content": out.content,
                        "model": params.model,
                        "sample_index": idx as i64,
                    });
                    sqlx::query(
                        "UPDATE collection_item_v2 \
                         SET status = 'completed', \
                             data = ?, error = NULL, \
                             backend = ?, input_tokens = ?, output_tokens = ?, \
                             cached_tokens = ?, latency_ms = ?, \
                             finished_at = CURRENT_TIMESTAMP, \
                             updated_at = CURRENT_TIMESTAMP \
                         WHERE collection_id = ? AND item_index = ?",
                    )
                    .bind(serde_json::to_string(&data).expect("serializable"))
                    .bind(out.backend.as_deref())
                    .bind(out.input_tokens.map(|n| n as i64))
                    .bind(out.output_tokens.map(|n| n as i64))
                    .bind(out.cached_tokens.map(|n| n as i64))
                    .bind(out.latency_ms)
                    .bind(collection_id)
                    .bind(idx as i64)
                    .execute(&pool)
                    .await?;
                    completed += 1;
                    debug!(exec_id, idx, "row completed");
                }
                Err(e) => {
                    record_failure(&pool, collection_id, idx as i64, &e).await?;
                    failed += 1;
                    last_error = Some(e);
                    error!(exec_id, idx, error = %last_error.as_deref().unwrap_or(""), "row failed");
                }
            }

            emit_progress(&ctx, exec_id, completed, failed, total);
        }

        // Terminal status: prefer "completed" when at least one row succeeded;
        // failures alongside successes are reported via the per-row state.
        // If every row failed, the leaf is failed.
        if completed == 0 && failed > 0 {
            let err = last_error.unwrap_or_else(|| "all inference rows failed".into());
            exec_svc.mark_failed(exec_id, &err).await?;
            ctx.emit(
                "execution-status",
                ExecutionStatusPayload {
                    exec_id,
                    status: "failed",
                    parent_id: exec.parent_id,
                    error: Some(err.clone()),
                },
            );
            return Err(WorkerError::Failed(err));
        }

        exec_svc.mark_completed(exec_id).await?;
        ctx.emit(
            "execution-status",
            ExecutionStatusPayload {
                exec_id,
                status: "completed",
                parent_id: exec.parent_id,
                error: None,
            },
        );
        info!(exec_id, completed, failed, "inference execution completed");
        Ok(())
    }
}

impl Worker for InferenceWorker {
    fn execute<'a>(
        &'a self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), WorkerError>> + Send + 'a>> {
        Box::pin(async move {
            match self.execute_inner(exec.clone(), version, ctx.clone()).await {
                Ok(()) => Ok(()),
                Err(WorkerError::Cancelled) => Ok(()),
                Err(e) => {
                    warn!(exec_id = exec.id, error = %e, "worker failed");
                    Err(e)
                }
            }
        })
    }
}

async fn record_failure(
    pool: &sqlx::SqlitePool,
    collection_id: i64,
    item_index: i64,
    error: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE collection_item_v2 \
         SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP, \
             updated_at = CURRENT_TIMESTAMP \
         WHERE collection_id = ? AND item_index = ?",
    )
    .bind(error)
    .bind(collection_id)
    .bind(item_index)
    .execute(pool)
    .await?;
    Ok(())
}

fn emit_progress(
    ctx: &WorkerContext,
    exec_id: i64,
    completed: i64,
    failed: i64,
    total: i64,
) {
    ctx.emit(
        "execution-progress",
        ExecutionProgressPayload { exec_id, completed, failed, total },
    );
}
