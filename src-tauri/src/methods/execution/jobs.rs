use super::*;

pub(crate) async fn create_inference_job_for_node(
    db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    data_source_override: Option<String>,
    model_override: Option<&str>,
    name_suffix: Option<&str>,
) -> Result<i64, String> {
    let snapshot_ref = execution_snapshot_ref(execution_id);
    let prompt_file = resolve_configured_file(
        method,
        &snapshot_ref,
        &node.id,
        config_string(node, method, "prompt_file", None),
        "prompt",
    )?;
    let has_upstream_sample = data_source_override.is_some();
    let data_source = match data_source_override {
        Some(source) => source,
        None => resolve_configured_file(
            method,
            &snapshot_ref,
            &node.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let json_schema_file = if config_string(node, method, "output_mode", Some("Unstructured"))
        .as_deref()
        == Some("JSON Schema")
    {
        Some(resolve_configured_file(
            method,
            &snapshot_ref,
            &node.id,
            config_string(node, method, "json_schema_file", None),
            "schema",
        )?)
    } else {
        None
    };
    let name = format!(
        "method-{}-{}-{}{}",
        method.id,
        execution_id,
        node.id,
        name_suffix.map(|suffix| format!("-{}", suffix)).unwrap_or_default()
    );
    let provider =
        config_string(node, method, "provider", Some("Local")).unwrap_or_else(|| "Local".into());
    let model = model_override
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| config_string(node, method, "model", Some("")).unwrap_or_default());
    let server_url = config_string(node, method, "server_url", Some("")).unwrap_or_default();
    let output_mode = config_string(node, method, "output_mode", Some("Unstructured"))
        .unwrap_or_else(|| "Unstructured".into());
    let temperature = config_f64(node, method, "temperature");
    let max_tokens = config_i32(node, method, "max_tokens", None);
    let samples = if has_upstream_sample {
        1
    } else {
        config_i32(node, method, "samples", Some(1)).unwrap_or(1)
    };
    let strategy = if has_upstream_sample {
        "exhaustive".to_string()
    } else {
        config_string(node, method, "strategy", Some("single")).unwrap_or_else(|| "single".into())
    };
    if server_url.trim().is_empty() {
        tracing::warn!(
            execution_id,
            method_id = %method.id,
            node_id = %node.id,
            provider = %provider,
            model = %model,
            model_override = ?model_override,
            "Creating Method inference job with an empty server_url"
        );
    }
    tracing::info!(
        execution_id,
        method_id = %method.id,
        node_id = %node.id,
        job_name = %name,
        provider = %provider,
        model = %model,
        server_url = %server_url,
        output_mode = %output_mode,
        temperature = ?temperature,
        max_tokens = ?max_tokens,
        samples,
        strategy = %strategy,
        prompt_file = %prompt_file,
        data_source = %data_source,
        json_schema_file = ?json_schema_file,
        "Creating Method inference job"
    );
    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, temperature, max_tokens, thinking_budget, samples, strategy,
            json_schema_file, status
        )
        VALUES (
            'inference', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(prompt_file)
    .bind(data_source)
    .bind(provider)
    .bind(model)
    .bind(server_url)
    .bind(output_mode)
    .bind(temperature)
    .bind(max_tokens)
    .bind(config_i32(node, method, "thinking_budget", None))
    .bind(samples)
    .bind(strategy)
    .bind(json_schema_file)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create inference job for method node '{}': {}", node.id, e))?;
    Ok(result.last_insert_rowid())
}

pub(crate) async fn create_sample_job_for_node(
    db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    data_source_override: Option<String>,
) -> Result<i64, String> {
    let snapshot_ref = execution_snapshot_ref(execution_id);
    let data_source = match data_source_override {
        Some(source) => source,
        None => resolve_configured_file(
            method,
            &snapshot_ref,
            &node.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let name = format!("method-{}-{}-{}", method.id, execution_id, node.id);
    let samples = config_i32(node, method, "samples", Some(1)).unwrap_or(1);
    let strategy =
        config_string(node, method, "strategy", Some("single")).unwrap_or_else(|| "single".into());

    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, status
        )
        VALUES (
            'sample', ?1, '', ?2, 'Nightshift', 'Sampling', '', 'Sample',
            ?3, ?4, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(data_source)
    .bind(samples)
    .bind(strategy)
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create sample job for method node '{}': {}", node.id, e))?;

    Ok(result.last_insert_rowid())
}

pub(crate) async fn create_transform_job_for_node(
    db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    execution_id: i64,
    data_source_override: Option<String>,
    name_suffix: Option<&str>,
) -> Result<i64, String> {
    let snapshot_ref = execution_snapshot_ref(execution_id);
    let data_source = match data_source_override {
        Some(source) => source,
        None => resolve_configured_file(
            method,
            &snapshot_ref,
            &node.id,
            config_string(node, method, "data_source", None),
            "data",
        )?,
    };
    let script_file = resolve_configured_file(
        method,
        &snapshot_ref,
        &node.id,
        config_string(node, method, "script_file", None),
        "script",
    )?;
    let name = format!(
        "method-{}-{}-{}{}",
        method.id,
        execution_id,
        node.id,
        name_suffix.map(|suffix| format!("-{}", suffix)).unwrap_or_default()
    );
    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, transform_script_file, transform_error_mode,
            transform_output_mode, status
        )
        VALUES (
            'transform', ?1, '', ?2, 'Nightshift', 'JavaScript', '', 'Transform',
            1, 'exhaustive', ?3, ?4, ?5, 'pending'
        )
        "#,
    )
    .bind(name)
    .bind(data_source)
    .bind(script_file)
    .bind(config_string(node, method, "error_mode", Some("stop")).unwrap_or_else(|| "stop".into()))
    .bind(
        config_string(node, method, "output_mode", Some("one_to_one"))
            .unwrap_or_else(|| "one_to_one".into()),
    )
    .execute(&db.pool())
    .await
    .map_err(|e| format!("Failed to create transform job for method node '{}': {}", node.id, e))?;
    Ok(result.last_insert_rowid())
}

pub(crate) fn execution_node_ref(execution_id: i64, node_id: &str) -> String {
    format!("execution:{}/node:{}", execution_id, node_id)
}

pub(crate) async fn upstream_output_source(
    _db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(dep) = runnable_dependency_ids(method, node).next() else {
        return Ok(None);
    };
    let Some(output_ref) = node_outputs.get(dep) else {
        return Ok(None);
    };
    Ok(Some(output_ref.clone()))
}

pub(crate) async fn upstream_job_sources(
    db: &DatabaseState,
    method: &MethodDocument,
    node: &MethodWorkflowNode,
    node_outputs: &HashMap<String, String>,
) -> Result<Vec<(i64, String)>, String> {
    let Some(dep) = runnable_dependency_ids(method, node).next() else {
        return Ok(vec![]);
    };
    let Some(output_ref) = node_outputs.get(dep) else {
        return Ok(vec![]);
    };
    let Some(source) = parse_execution_node_ref(output_ref)? else {
        return Ok(vec![]);
    };
    let job_ids = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT DISTINCT job_id
        FROM method_execution_outputs
        WHERE execution_id = ?1
          AND node_id = ?2
          AND job_id IS NOT NULL
        ORDER BY job_id ASC
        "#,
    )
    .bind(source.execution_id)
    .bind(&source.node_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to list upstream execution jobs: {}", e))?;

    Ok(job_ids
        .into_iter()
        .map(|job_id| (job_id, format!("{}/job:{}", output_ref, job_id)))
        .collect())
}
