use super::*;

#[tokio::test]
async fn read_method_artifact_returns_inline_content() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-artifact-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let db = DatabaseState::new(&temp).await.unwrap();
    let execution_id = insert_execution(&db, &sample_method(), "hash").await.unwrap();
    insert_artifact(
        &db,
        execution_id,
        Some("analysis"),
        "analysis",
        "inline_markdown",
        "# Analysis",
    )
    .await
    .unwrap();
    let artifact = sqlx::query_as::<_, MethodArtifactSummary>(
        "SELECT id, execution_id, node_id, file_type, path, content_hash, created_at FROM method_execution_files WHERE execution_id = ?",
    )
    .bind(execution_id)
    .fetch_one(&db.pool())
    .await
    .unwrap();
    let content = read_method_artifact_from_db(&db, artifact.id).await.unwrap();

    assert_eq!(content, "# Analysis");
    assert_eq!(artifact.file_type, "inline_markdown");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn append_jsonl_writes_complete_lines_under_concurrent_calls() {
    use std::sync::{Arc, Barrier};

    let temp =
        std::env::temp_dir().join(format!("nightshift-jsonl-append-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).unwrap();
    let path = temp.join("log.jsonl");
    let barrier = Arc::new(Barrier::new(8));
    let handles = (0..8)
        .map(|index| {
            let barrier = Arc::clone(&barrier);
            let path = path.clone();
            std::thread::spawn(move || {
                barrier.wait();
                append_jsonl(&path, &serde_json::json!({ "index": index })).unwrap();
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        handle.join().unwrap();
    }

    let content = fs::read_to_string(&path).unwrap();
    let mut seen = content
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["index"].as_i64().unwrap()
        })
        .collect::<Vec<_>>();
    seen.sort();

    assert_eq!(seen, vec![0, 1, 2, 3, 4, 5, 6, 7]);
    fs::remove_dir_all(temp).unwrap();
}
