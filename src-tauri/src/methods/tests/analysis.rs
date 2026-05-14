use super::*;

#[test]
fn model_values_reads_parameter_sweep() {
    let mut method = sample_method();
    method.parameters = serde_yaml::from_str(
        r#"
model_values:
  - bonsai-8b
  - qwen3.5-4b
"#,
    )
    .unwrap();

    assert_eq!(model_values(&method), vec!["bonsai-8b", "qwen3.5-4b"]);
}

#[test]
fn method_tool_schema_exposes_analysis_without_aggregate() {
    let tools = crate::methods::method_function_tools();
    let replace_graph = tools
        .iter()
        .find(|tool| {
            tool.get("name").and_then(serde_json::Value::as_str)
                == Some("replace_method_draft_graph")
        })
        .unwrap();
    let enum_values = replace_graph["parameters"]["properties"]["workflow"]["properties"]["nodes"]
        ["items"]["properties"]["type"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();

    assert!(enum_values.contains(&"analysis"));
    assert!(!enum_values.contains(&"output_file"));
    assert!(!enum_values.contains(&"aggregate"));
    assert!(replace_graph["parameters"]["properties"]["workflow"]["properties"]["nodes"]["items"]
        ["properties"]["config"]["properties"]
        .as_object()
        .unwrap()
        .get("output_file")
        .is_none());
    let config_properties = replace_graph["parameters"]["properties"]["workflow"]["properties"]
        ["nodes"]["items"]["properties"]["config"]["properties"]
        .as_object()
        .unwrap();
    for key in ["samples", "strategy", "model", "server_url", "prompt_file", "json_schema_file"] {
        assert!(config_properties.contains_key(key), "missing config key {key}");
    }
}

#[test]
fn aggregate_draft_nodes_are_normalized_to_analysis() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-normalize-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join(".nightshift")).unwrap();
    create_draft_for_root(
        &temp,
        CreateMethodDraftInput {
            title: Some("Normalize aggregate".into()),
            objective: Some("Migrate aggregate draft nodes".into()),
        },
    )
    .unwrap();

    let draft = crate::methods::draft::replace_draft_graph_for_root(
        &temp,
        ReplaceMethodDraftGraphInput {
            workflow: MethodWorkflow {
                nodes: vec![MethodWorkflowNode {
                    id: "aggregate".into(),
                    label: "Aggregate".into(),
                    node_type: "aggregate".into(),
                    kind: None,
                    path: None,
                    reference: None,
                    depends_on: vec![],
                    config: serde_json::Value::Null,
                }],
            },
        },
    )
    .unwrap();

    assert_eq!(draft.workflow.nodes[0].node_type, "analysis");
    assert_eq!(
        get_current_draft_for_root(&temp).unwrap().unwrap().workflow.nodes[0].node_type,
        "analysis"
    );
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn analysis_sql_guardrails_allow_only_read_queries() {
    assert!(validate_analysis_sql("SELECT * FROM method_execution_outputs").is_ok());
    assert!(validate_analysis_sql("WITH rows AS (SELECT 1 AS n) SELECT n FROM rows;").is_ok());
    for sql in [
        "INSERT INTO method_execution_outputs VALUES (1)",
        "SELECT 1; SELECT 2",
        "PRAGMA table_info(method_execution_outputs)",
        "SELECT 1 -- hidden",
        "/* hidden */ SELECT 1",
        "WITH deleted AS (DELETE FROM method_execution_outputs RETURNING *) SELECT * FROM deleted",
    ] {
        assert!(validate_analysis_sql(sql).is_err(), "query should be rejected: {sql}");
    }
}

#[tokio::test]
async fn analysis_sql_query_applies_row_limit() {
    let temp = std::env::temp_dir()
        .join(format!("nightshift-method-analysis-sql-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();

    let job_id = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            job_type, name, prompt_file, data_source, provider, model, server_url,
            output_mode, samples, strategy, status
        )
        VALUES ('inference', 'agg-job', 'p', 'd', 'Local', 'bonsai-8b', 'http://localhost:1234',
            'Unstructured', 1, 'single', 'completed')
        "#,
    )
    .execute(&db.pool())
    .await
    .unwrap()
    .last_insert_rowid();
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
    for item in [serde_json::json!({ "pass": true }), serde_json::json!({ "pass": false })] {
        sqlx::query(
            "INSERT INTO method_execution_outputs (execution_id, node_id, job_id, data) VALUES (?1, 'analysis', ?2, ?3)",
        )
            .bind(execution_id)
            .bind(job_id)
            .bind(item)
            .execute(&db.pool())
            .await
            .unwrap();
    }

    let result =
        run_analysis_sql_query(&db, "SELECT id, data FROM method_execution_outputs ORDER BY id", 1)
            .await
            .unwrap();

    assert_eq!(result["row_count"], 1);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["rows"][0]["data"]["pass"], true);
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn analysis_report_artifact_requires_required_sections() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-report-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
    let report = r#"# Experiment Report

## Abstract
Summary.

## Method Summary
Method.

## Data Summaries
Data.

## Discussion Points
Discussion.

## Caveats
Caveats.

## Conclusion
Conclusion.
"#;

    let mut method = sample_method();
    method.id = "report-method".into();
    let node = MethodWorkflowNode {
        id: "analysis".into(),
        label: "Analyze".into(),
        node_type: "analysis".into(),
        kind: None,
        path: None,
        reference: None,
        depends_on: vec![],
        config: serde_json::Value::Null,
    };

    let output_ref =
        insert_analysis_report_artifact(&db, &method, execution_id, &node, report).await.unwrap();
    let bad_report = report.replace("## Caveats", "## Limitations");

    assert!(output_ref.starts_with("file:"));
    assert!(temp
        .join(".nightshift/executions")
        .join(execution_id.to_string())
        .join("files")
        .join("analysis")
        .join("analysis.md")
        .is_file());
    assert!(insert_analysis_report_artifact(&db, &method, execution_id, &node, &bad_report)
        .await
        .is_err());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn analysis_node_path_controls_analysis_report_location() {
    let mut method = sample_method();
    method.id = "branch-method".into();
    let node = MethodWorkflowNode {
        id: "analyze_branch_a".into(),
        label: "Analyze branch A".into(),
        node_type: "analysis".into(),
        kind: None,
        path: Some("branch-a/report".into()),
        reference: None,
        depends_on: vec![],
        config: serde_json::json!({}),
    };

    let path = analysis_report_relative_path(&method, 42, &node).unwrap();

    assert_eq!(
        path.to_string_lossy().replace('\\', "/"),
        ".nightshift/executions/42/files/analyze_branch_a/branch-a/report.md"
    );
    assert!(!path.starts_with("methods/branch-method"));
}

#[test]
fn output_file_node_type_is_rejected() {
    let mut method = sample_method();
    method.workflow.nodes.push(MethodWorkflowNode {
        id: "report_file".into(),
        label: "Report file".into(),
        node_type: "output_file".into(),
        kind: None,
        path: Some("report.md".into()),
        reference: None,
        depends_on: vec!["analysis".into()],
        config: serde_json::json!({}),
    });

    let err = validate_method(&method).unwrap_err();

    assert!(err.contains("removed type 'output_file'"), "got: {err}");
}

#[test]
fn analysis_report_repair_prompt_requires_exact_headings() {
    let prompt = analysis_report_repair_prompt(
        "Analysis report is missing required section 'Abstract'",
        "# Abstract\nDraft",
    );

    for heading in [
        "## Abstract",
        "## Method Summary",
        "## Data Summaries",
        "## Discussion Points",
        "## Caveats",
        "## Conclusion",
    ] {
        assert!(prompt.contains(heading), "missing heading in prompt: {heading}");
    }
    assert!(prompt.contains("Prior draft"));
    assert!(prompt.contains("# Abstract\nDraft"));
}
