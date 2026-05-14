#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::execution::sampling::SamplingStrategy;

    #[test]
    fn extract_content_falls_back_to_reasoning_when_content_empty() {
        // Real-world Qwen3 response shape: model put the JSON in
        // reasoning_content and left content empty.
        let body = r#"{
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "{\"word\":\"gehen\"}"
                }
            }]
        }"#;
        let resp: LlmResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.choices[0].message.extract_content(), "{\"word\":\"gehen\"}");
    }

    #[test]
    fn extract_content_prefers_content_when_present() {
        let body = r#"{
            "choices": [{
                "message": {
                    "content": "real answer",
                    "reasoning_content": "internal monologue"
                }
            }]
        }"#;
        let resp: LlmResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.choices[0].message.extract_content(), "real answer");
    }

    #[test]
    fn extract_content_handles_missing_fields() {
        let body = r#"{"choices": [{"message": {"role": "assistant"}}]}"#;
        let resp: LlmResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.choices[0].message.extract_content(), "");
    }

    #[test]
    fn render_prompt_exposes_sample_fields_at_top_level() {
        let sample = serde_json::json!({"word": "gehen", "language": "German"});
        let out = render_prompt("Translate {{ word }} ({{ language }})", &sample).unwrap();
        assert_eq!(out, "Translate gehen (German)");
    }

    #[test]
    fn render_prompt_errors_on_undefined_variable() {
        // Previously: silently rendered as "" and the LLM hallucinated a default.
        let sample = serde_json::json!({"word": "gehen"});
        let err = render_prompt("{{ language }}", &sample).unwrap_err();
        assert!(err.contains("language") || err.contains("undefined"), "got: {err}");
    }

    #[test]
    fn render_prompt_rejects_non_object_sample() {
        let err = render_prompt("{{ x }}", &serde_json::json!([1, 2, 3])).unwrap_err();
        assert!(err.contains("must be a JSON object"), "got: {err}");
    }

    async fn make_executor() -> (JobExecutor, std::path::PathBuf) {
        use std::env;
        use uuid::Uuid;
        let project_dir = env::temp_dir().join(format!("ns_exec_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(project_dir.join(".nightshift")).unwrap();
        let db = DatabaseState::new(&project_dir).await.expect("db");
        let exec = JobExecutor { db, queue: Arc::new(JobQueue::new()), client: Client::new() };
        (exec, project_dir)
    }

    async fn make_execution_outputs(exec: &JobExecutor, items: &[&str]) -> (i64, String) {
        let execution_id: i64 = sqlx::query_scalar(
            "INSERT INTO method_executions (method_id, method_content_hash, status) VALUES ('m', 'h', 'completed') RETURNING id",
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();
        let node_id = "source".to_string();
        sqlx::query(
            "INSERT INTO method_execution_nodes (execution_id, node_id, node_type, status) VALUES (?, ?, 'sample', 'completed')",
        )
        .bind(execution_id)
        .bind(&node_id)
        .execute(&exec.db.pool())
        .await
        .unwrap();
        for (index, item) in items.iter().enumerate() {
            let data: serde_json::Value = serde_json::from_str(item).unwrap();
            sqlx::query(
                "INSERT INTO method_execution_outputs (execution_id, node_id, sample_index, data) VALUES (?, ?, ?, ?)",
            )
            .bind(execution_id)
            .bind(&node_id)
            .bind(index as i64)
            .bind(data)
            .execute(&exec.db.pool())
            .await
            .unwrap();
        }
        (execution_id, node_id)
    }

    #[tokio::test]
    async fn load_execution_node_samples_returns_items() {
        let (exec, dir) = make_executor().await;
        let (execution_id, node_id) =
            make_execution_outputs(&exec, &[r#"{"content":"hi"}"#, r#"{"content":"bye"}"#]).await;

        let cfg = WorkerConfig {
            job_id: 1,
            job_type: "sample".into(),
            name: "n".into(),
            prompt_file: "".into(),
            data_source: format!("execution:{}/node:{}", execution_id, node_id),
            provider: "Nightshift".into(),
            model: "Sampling".into(),
            server_url: "".into(),
            output_mode: "Sample".into(),
            temperature: None,
            max_tokens: None,
            thinking_budget: None,
            samples: 1,
            strategy: SamplingStrategy::Exhaustive,
            json_schema_file: None,
            transform_script_file: None,
            transform_error_mode: "stop".into(),
            transform_output_mode: "one_to_one".into(),
        };
        let out = exec.load_samples(&cfg).await.unwrap();
        assert_eq!(out.len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn load_execution_node_samples_refuses_incomplete_source_node() {
        let (exec, dir) = make_executor().await;
        let execution_id: i64 = sqlx::query_scalar(
            "INSERT INTO method_executions (method_id, method_content_hash, status) VALUES ('m', 'h', 'running') RETURNING id",
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO method_execution_nodes (execution_id, node_id, node_type, status) VALUES (?, 'source', 'sample', 'running')",
        )
        .bind(execution_id)
        .execute(&exec.db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO method_execution_outputs (execution_id, node_id, sample_index, data) VALUES (?, 'source', 0, ?)",
        )
        .bind(execution_id)
        .bind(serde_json::json!({ "content": "not ready" }))
        .execute(&exec.db.pool())
        .await
        .unwrap();

        let cfg = WorkerConfig {
            job_id: 1,
            job_type: "sample".into(),
            name: "n".into(),
            prompt_file: "".into(),
            data_source: format!("execution:{}/node:source", execution_id),
            provider: "Nightshift".into(),
            model: "Sampling".into(),
            server_url: "".into(),
            output_mode: "Sample".into(),
            temperature: None,
            max_tokens: None,
            thinking_budget: None,
            samples: 1,
            strategy: SamplingStrategy::Exhaustive,
            json_schema_file: None,
            transform_script_file: None,
            transform_error_mode: "stop".into(),
            transform_output_mode: "one_to_one".into(),
        };

        let err = exec.load_samples(&cfg).await.unwrap_err();
        assert!(err.contains("node is running"), "got: {err}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn load_execution_node_samples_filters_by_job_ref() {
        let (exec, dir) = make_executor().await;
        let execution_id: i64 = sqlx::query_scalar(
            "INSERT INTO method_executions (method_id, method_content_hash, status) VALUES ('m', 'h', 'completed') RETURNING id",
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO method_execution_nodes (execution_id, node_id, node_type, status) VALUES (?, 'source', 'inference', 'completed')",
        )
        .bind(execution_id)
        .execute(&exec.db.pool())
        .await
        .unwrap();
        for (job_id, label) in [(10_i64, "a"), (20_i64, "b")] {
            sqlx::query(
                "INSERT INTO method_execution_outputs (execution_id, node_id, job_id, sample_index, data) VALUES (?, 'source', ?, 0, ?)",
            )
            .bind(execution_id)
            .bind(job_id)
            .bind(serde_json::json!({ "label": label }))
            .execute(&exec.db.pool())
            .await
            .unwrap();
        }

        let cfg = WorkerConfig {
            job_id: 1,
            job_type: "sample".into(),
            name: "n".into(),
            prompt_file: "".into(),
            data_source: format!("execution:{}/node:source/job:20", execution_id),
            provider: "Nightshift".into(),
            model: "Sampling".into(),
            server_url: "".into(),
            output_mode: "Sample".into(),
            temperature: None,
            max_tokens: None,
            thinking_budget: None,
            samples: 1,
            strategy: SamplingStrategy::Exhaustive,
            json_schema_file: None,
            transform_script_file: None,
            transform_error_mode: "stop".into(),
            transform_output_mode: "one_to_one".into(),
        };

        let out = exec.load_samples(&cfg).await.unwrap();
        assert_eq!(out, vec![serde_json::json!({ "label": "b" })]);

        let missing_cfg = WorkerConfig {
            data_source: format!("execution:{}/node:source/job:99", execution_id),
            ..cfg
        };
        let err = exec.load_samples(&missing_cfg).await.unwrap_err();
        assert!(err.contains("/job:99"), "got: {err}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn load_samples_routes_invalid_execution_ref_to_error() {
        let (exec, dir) = make_executor().await;
        let cfg = WorkerConfig {
            job_id: 1,
            job_type: "inference".into(),
            name: "n".into(),
            prompt_file: "p".into(),
            data_source: "execution:abc".into(),
            provider: "Local".into(),
            model: "m".into(),
            server_url: "http://x".into(),
            output_mode: "Unstructured".into(),
            temperature: None,
            max_tokens: None,
            thinking_budget: None,
            samples: 1,
            strategy: SamplingStrategy::Single,
            json_schema_file: None,
            transform_script_file: None,
            transform_error_mode: "stop".into(),
            transform_output_mode: "one_to_one".into(),
        };
        let err = exec.load_samples(&cfg).await.unwrap_err();
        assert!(
            err.contains("Invalid execution output reference")
                || err.contains("Invalid execution id"),
            "got: {err}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_sample_job_persists_exact_sampled_rows() {
        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"name":"Ada"}
{"name":"Grace"}
{"name":"Katherine"}"#,
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, status
            )
            VALUES ('sample', 'sample rows', '', 'input.jsonl', 'Nightshift', 'Sampling', '',
                'Sample', 2, 'exhaustive', 'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(64);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"
            SELECT data
            FROM job_outputs
            WHERE job_id = ?
            ORDER BY id ASC
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();

        assert_eq!(
            rows,
            vec![
                serde_json::json!({ "name": "Ada" }),
                serde_json::json!({ "name": "Ada" }),
                serde_json::json!({ "name": "Grace" }),
                serde_json::json!({ "name": "Grace" }),
                serde_json::json!({ "name": "Katherine" }),
                serde_json::json!({ "name": "Katherine" }),
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_writes_non_null_outputs() {
        if crate::execution::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"value":21}
{"value":0}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("double.js"),
            "return item.value ? { value: item.value * 2 } : null;",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'double', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/double.js', 'stop', 'one_to_one',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"
            SELECT data
            FROM job_outputs
            WHERE job_id = ?
            ORDER BY id ASC
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();

        assert_eq!(rows, vec![serde_json::json!({ "value": 42 })]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_unwraps_array_outputs_when_configured() {
        if crate::execution::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"questions":[{"content":"A","answer":"a"},{"content":"B","answer":"b"}]}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("unwrap.js"),
            "return item.questions.map((q) => ({ content: q.content, answer: q.answer }));",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'unwrap', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/unwrap.js', 'stop', 'unwrap_arrays',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"
            SELECT data
            FROM job_outputs
            WHERE job_id = ?
            ORDER BY id ASC
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();

        assert_eq!(
            rows,
            vec![
                serde_json::json!({ "content": "A", "answer": "a" }),
                serde_json::json!({ "content": "B", "answer": "b" }),
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_unwraps_json_content_from_execution_output() {
        if crate::execution::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        let (source_execution_id, source_node_id) = make_execution_outputs(
            &exec,
            &[r#"{"content":"{\"questions\":[{\"content\":\"A ___\",\"answer\":\"a\"},{\"content\":\"B ___\",\"answer\":\"b\"}],\"topic\":\"letters\"}","model":"test"}"#],
        )
        .await;
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("questions.js"),
            "return item.questions.map((q) => ({ topic: item.topic, content: q.content, answer: q.answer }));",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'execution-unwrap', '', ?, 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/questions.js', 'stop', 'unwrap_arrays',
                'pending')
            RETURNING id
            "#,
        )
        .bind(format!("execution:{}/node:{}", source_execution_id, source_node_id))
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let rows = sqlx::query_scalar::<_, serde_json::Value>(
            r#"
            SELECT data
            FROM job_outputs
            WHERE job_id = ?
            ORDER BY id ASC
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();

        assert_eq!(
            rows,
            vec![
                serde_json::json!({ "topic": "letters", "content": "A ___", "answer": "a" }),
                serde_json::json!({ "topic": "letters", "content": "B ___", "answer": "b" }),
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_stop_mode_removes_partial_outputs() {
        if crate::execution::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"value":21}
{"value":0}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("fail.js"),
            "if (!item.value) throw new Error('bad row'); return { value: item.value };",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'fail', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/fail.js', 'stop', 'one_to_one',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();
        while rx.recv().await.is_some() {}

        let output_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM job_outputs WHERE job_id = ?")
                .bind(job_id)
                .fetch_one(&exec.db.pool())
                .await
                .unwrap();
        assert_eq!(output_count, 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn execute_transform_job_skip_mode_records_item_failures() {
        if crate::execution::transform_runner::check_transform_runtime().await.is_err() {
            return;
        }

        let (exec, dir) = make_executor().await;
        std::fs::write(
            dir.join("input.jsonl"),
            r#"{"value":21}
{"value":0}
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("transforms")).unwrap();
        std::fs::write(
            dir.join("transforms").join("skip.js"),
            "if (!item.value) throw new Error('bad row'); return { value: item.value };",
        )
        .unwrap();

        let job_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO inference_jobs (
                job_type, name, prompt_file, data_source, provider, model, server_url,
                output_mode, samples, strategy, transform_script_file, transform_error_mode,
                transform_output_mode, status
            )
            VALUES ('transform', 'skip', '', 'input.jsonl', 'Nightshift', 'JavaScript', '',
                'Transform', 1, 'exhaustive', 'transforms/skip.js', 'skip', 'one_to_one',
                'pending')
            RETURNING id
            "#,
        )
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();

        exec.queue.enqueue(job_id).await;
        exec.queue.start(job_id).await;
        let job = crate::database::get_inference_job_by_id(&exec.db.pool(), job_id)
            .await
            .unwrap()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);

        exec.execute_job(WorkerConfig::from_job(job), tx).await.unwrap();

        let mut completed_event = None;
        while let Some(event) = rx.recv().await {
            if let JobEvent::Completed { success_count, failure_count, .. } = event {
                completed_event = Some((success_count, failure_count));
            }
        }

        assert_eq!(completed_event, Some((1, 1)));

        let failures = sqlx::query_as::<_, crate::database::JobFailure>(
            r#"
            SELECT id, job_id, sample_index, error, created_at
            FROM job_failures
            WHERE job_id = ?
            "#,
        )
        .bind(job_id)
        .fetch_all(&exec.db.pool())
        .await
        .unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].sample_index, 1);
        assert!(failures[0].error.contains("bad row"));

        let output_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM job_outputs
            WHERE job_id = ?
            "#,
        )
        .bind(job_id)
        .fetch_one(&exec.db.pool())
        .await
        .unwrap();
        assert_eq!(output_count, 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn thinking_budget_to_effort_buckets() {
        assert_eq!(thinking_budget_to_effort(None), None);
        assert_eq!(thinking_budget_to_effort(Some(0)), None);
        assert_eq!(thinking_budget_to_effort(Some(-100)), None);
        assert_eq!(thinking_budget_to_effort(Some(500)), Some("low".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(750)), Some("low".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(1000)), Some("medium".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(1250)), Some("medium".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(1500)), Some("high".to_string()));
        assert_eq!(thinking_budget_to_effort(Some(2000)), Some("high".to_string()));
    }
}
