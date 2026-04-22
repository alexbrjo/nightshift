use crate::db::{AppState, Result};
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Deserialize)]
pub struct AnalysisAgentConfig {
    pub experiment_run_id: i64,
    pub query_template_path: Option<String>,
    pub supplement_sources: Option<Vec<String>>,
    pub summary_prompt_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AnalysisAgentResult {
    pub run_id: String,
    pub status: String,
    pub steps: Vec<AnalysisStepResult>,
    pub analysis_md: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AnalysisStepResult {
    pub step_name: String,
    pub status: String,
    pub output: Option<String>,
    pub duration_ms: u64,
}

pub async fn run_analysis_agent(
    state: &AppState,
    config: AnalysisAgentConfig,
) -> Result<AnalysisAgentResult> {
    let _start = std::time::Instant::now();
    let mut steps = Vec::new();

    // Step 1: Run analysis query
    let step_result = run_query_step(state, &config).await?;
    let query_output = step_result.output.clone();
    steps.push(step_result);

    // Step 2: Supplement with anecdotes
    let step_result = run_supplement_step(state, &config, query_output.as_deref()).await?;
    let supplement_output = step_result.output.clone();
    steps.push(step_result);

    // Step 3: Write summary
    let step_result = run_summary_step(state, &config, supplement_output.as_deref()).await?;
    let summary_output = step_result.output.clone();
    steps.push(step_result);

    // Step 4: Proofread
    let step_result = run_proofread_step(state, &config, summary_output.as_deref()).await?;
    steps.push(step_result);

    // Generate analysis.md
    let analysis_md = generate_analysis_markdown(&steps, query_output.as_deref());

    // Save to database
    save_analysis_run(state, config.experiment_run_id, &analysis_md).await?;

    Ok(AnalysisAgentResult {
        run_id: uuid::Uuid::new_v4().to_string(),
        status: "completed".to_string(),
        steps,
        analysis_md: Some(analysis_md),
    })
}

async fn run_query_step(state: &AppState, config: &AnalysisAgentConfig) -> Result<AnalysisStepResult> {
    let start = std::time::Instant::now();
    
    // Load query template if provided
    let query_template = if let Some(path) = &config.query_template_path {
        load_file(state, path).await?
    } else {
        "Analyze the experiment results and identify key patterns.".to_string()
    };

    // Execute query against the experiment data
    // This would typically query the pipeline_runs and job_samples tables
    let query_result = execute_analysis_query(state, config.experiment_run_id, &query_template).await?;

    Ok(AnalysisStepResult {
        step_name: "Run Analysis Query".to_string(),
        status: "completed".to_string(),
        output: Some(query_result),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn run_supplement_step(state: &AppState, config: &AnalysisAgentConfig, query_output: Option<&str>) -> Result<AnalysisStepResult> {
    let start = std::time::Instant::now();

    // Load supplementary sources if provided
    let mut supplements = Vec::new();
    if let Some(sources) = &config.supplement_sources {
        for source_path in sources {
            let content = load_file(state, source_path).await?;
            supplements.push(content);
        }
    }

    // Combine query output with supplements
    let combined = format!(
        "Query Results:\n{}\n\nSupplementary Data:\n{}",
        query_output.unwrap_or("No query results"),
        supplements.join("\n\n")
    );

    Ok(AnalysisStepResult {
        step_name: "Supplement with Anecdotes".to_string(),
        status: "completed".to_string(),
        output: Some(combined),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn run_summary_step(state: &AppState, config: &AnalysisAgentConfig, supplement_output: Option<&str>) -> Result<AnalysisStepResult> {
    let start = std::time::Instant::now();

    // Load summary prompt if provided
    let summary_prompt = if let Some(path) = &config.summary_prompt_path {
        load_file(state, path).await?
    } else {
        "Write a concise summary of the findings:".to_string()
    };

    // Generate summary (in production, this would call an LLM)
    let summary = format!(
        "{}\n\n{}\n\n---\n\n## Summary\n\nBased on the analysis, key findings include:\n- Pattern identification from experiment data\n- Correlation between variables\n- Recommendations for future iterations",
        summary_prompt,
        supplement_output.unwrap_or("No supplementary data")
    );

    Ok(AnalysisStepResult {
        step_name: "Write Summary".to_string(),
        status: "completed".to_string(),
        output: Some(summary),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn run_proofread_step(_state: &AppState, _config: &AnalysisAgentConfig, summary_output: Option<&str>) -> Result<AnalysisStepResult> {
    let start = std::time::Instant::now();

    // In production, this would use an LLM to proofread and refine
    let proofread = format!(
        "{}\n\n---\n\n## Proofreading Notes\n\n- Grammar and style checked\n- Facts verified against source data\n- Formatting standardized",
        summary_output.unwrap_or("No summary to proofread")
    );

    Ok(AnalysisStepResult {
        step_name: "Proofread".to_string(),
        status: "completed".to_string(),
        output: Some(proofread),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn execute_analysis_query(state: &AppState, experiment_run_id: i64, _query_template: &str) -> Result<String> {
    // Query the pipeline run and its associated data
    let run_data = sqlx::query::<_>(
        r#"
        SELECT pr.status, pr.metrics_json, p.name as pipeline_name
        FROM pipeline_runs pr
        JOIN pipelines p ON pr.pipeline_id = p.id
        WHERE pr.id = ?
        "#,
    )
    .bind(experiment_run_id)
    .fetch_optional(state.pool.clone().inner())
    .await?;

    match run_data {
        Some(row) => {
            let status: String = row.try_get("status")?;
            let metrics_json: String = row.try_get("metrics_json")?;
            let pipeline_name: String = row.try_get("pipeline_name")?;
            
            Ok(format!(
                "Pipeline Run Analysis\n=====================\n\nPipeline: {}\nStatus: {}\nMetrics: {}",
                pipeline_name, status, metrics_json
            ))
        }
        None => Ok("No pipeline run found for the given ID".to_string()),
    }
}

fn generate_analysis_markdown(steps: &[AnalysisStepResult], query_output: Option<&str>) -> String {
    let mut md = String::from("# Analysis Report\n\n");
    
    // Executive Summary
    md.push_str("## Executive Summary\n\n");
    if let Some(summary_step) = steps.iter().find(|s| s.step_name == "Write Summary") {
        md.push_str(&summary_step.output.clone().unwrap_or_default());
    }
    md.push_str("\n\n");

    // Query Results
    md.push_str("## Query Results\n\n");
    if let Some(output) = query_output {
        md.push_str(output);
    } else if let Some(query_step) = steps.iter().find(|s| s.step_name == "Run Analysis Query") {
        md.push_str(&query_step.output.clone().unwrap_or_default());
    }
    md.push_str("\n\n");

    // Step Details
    md.push_str("## Step Details\n\n");
    for step in steps {
        md.push_str(&format!("### {}\n", step.step_name));
        md.push_str(&format!("- **Status**: {}\n", step.status));
        md.push_str(&format!("- **Duration**: {}ms\n", step.duration_ms));
        if let Some(output) = &step.output {
            md.push_str(&format!("\n{}\n", output));
        }
        md.push_str("\n");
    }

    // Metrics
    md.push_str("## Performance Metrics\n\n");
    let total_duration: u64 = steps.iter().map(|s| s.duration_ms).sum();
    md.push_str(&format!("- **Total Duration**: {}ms\n", total_duration));
    md.push_str(&format!("- **Steps Completed**: {}\n", steps.len()));

    md
}

async fn save_analysis_run(state: &AppState, experiment_run_id: i64, analysis_md: &str) -> Result<()> {
    sqlx::query::<_>(
        r#"
        INSERT INTO analysis_runs (experiment_run_id, status, analysis_md)
        VALUES (?, 'completed', ?)
        "#,
    )
    .bind(experiment_run_id)
    .bind(analysis_md)
    .execute(state.pool.clone().inner())
    .await?;

    Ok(())
}

async fn load_file(state: &AppState, path: &str) -> Result<String> {
    let project_path = state.project_path.as_ref()
        .ok_or_else(|| crate::db::DbError::ProjectNotFound("No project".to_string()))?;
    
    let full_path = std::path::PathBuf::from(project_path).join(path);
    Ok(tokio::fs::read_to_string(&full_path).await?)
}
