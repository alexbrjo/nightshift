#[cfg(test)]
mod collection_commands_tests {
    use crate::database::{
        delete_collection_item_by_id, export_collection_csv_by_id, export_collection_jsonl_by_id,
        format_csv_value, list_selectable_collections_with_pool, DatabaseState,
    };
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, OnceLock};
    use uuid::Uuid;

    // Global lock to prevent race conditions in file system tests
    static TEST_LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();

    fn get_test_lock() -> &'static Arc<Mutex<()>> {
        TEST_LOCK.get_or_init(|| Arc::new(Mutex::new(())))
    }

    async fn create_test_database() -> (DatabaseState, PathBuf) {
        let _guard = get_test_lock().lock().unwrap();

        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_collection_project_{}", unique_id));
        let nightshift_dir = project_dir.join(".nightshift");

        fs::create_dir_all(&nightshift_dir).expect("Failed to create test directory");

        let db_state = DatabaseState::new(&project_dir).await.expect("Failed to create database");

        (db_state, project_dir)
    }

    fn cleanup_test_database(project_dir: &PathBuf) {
        fs::remove_dir_all(project_dir).ok();
    }

    #[tokio::test]
    async fn test_delete_collection_item() {
        let (state, project_dir) = create_test_database().await;

        // First create a job and collection
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("test_job")
        .bind("/path/to/prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("completed")
        .execute(&state.pool())
        .await
        .expect("Failed to insert job");

        let job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&state.pool())
            .await
            .expect("Failed to get job ID");

        let collection_id: i64 =
            sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
                .bind(job_id)
                .bind("test_collection")
                .fetch_one(&state.pool())
                .await
                .expect("Failed to create collection");

        // Add an item
        let item_id: i64 = sqlx::query_scalar(
            "INSERT INTO collection_items (collection_id, data) VALUES (?, ?) RETURNING id",
        )
        .bind(collection_id)
        .bind(r#"{"key": "value"}"#)
        .fetch_one(&state.pool())
        .await
        .expect("Failed to insert item");

        // Delete the item using the command
        let result = delete_collection_item_by_id(&state.pool(), item_id).await;
        assert!(result.is_ok(), "Delete should succeed: {:?}", result.err());
        assert!(result.unwrap(), "Should report that a row was deleted");

        // Verify item is gone
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collection_items WHERE id = ?")
            .bind(item_id)
            .fetch_one(&state.pool())
            .await
            .expect("Failed to count items");
        assert_eq!(count, 0, "Item should be deleted");

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_delete_nonexistent_collection_item() {
        let (state, project_dir) = create_test_database().await;

        // Try to delete a non-existent item
        let result = delete_collection_item_by_id(&state.pool(), 99999).await;
        assert!(result.is_ok(), "Delete should succeed even for non-existent item");
        assert!(!result.unwrap(), "Should report that no row was deleted");

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_export_collection_jsonl() {
        let (state, project_dir) = create_test_database().await;

        // Create job and collection
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("test_job")
        .bind("/path/to/prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("completed")
        .execute(&state.pool())
        .await
        .expect("Failed to insert job");

        let job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&state.pool())
            .await
            .expect("Failed to get job ID");

        let collection_id: i64 =
            sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
                .bind(job_id)
                .bind("test_collection")
                .fetch_one(&state.pool())
                .await
                .expect("Failed to create collection");

        // Add items with different data
        let item1_data = r#"{"name": "Alice", "age": 30}"#;
        let item2_data = r#"{"name": "Bob", "age": 25}"#;

        sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?, ?)")
            .bind(collection_id)
            .bind(item1_data)
            .execute(&state.pool())
            .await
            .expect("Failed to insert item 1");

        sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?, ?)")
            .bind(collection_id)
            .bind(item2_data)
            .execute(&state.pool())
            .await
            .expect("Failed to insert item 2");

        // Export as JSONL
        let result = export_collection_jsonl_by_id(&state.pool(), collection_id).await;
        assert!(result.is_ok(), "Export should succeed: {:?}", result.err());

        let jsonl_content = result.unwrap();
        let lines: Vec<&str> = jsonl_content.lines().collect();

        assert_eq!(lines.len(), 2, "Should have 2 lines");

        // Parse and verify each line
        let parsed1: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let parsed2: serde_json::Value = serde_json::from_str(lines[1]).unwrap();

        assert!(parsed1.get("data").is_some(), "First item should have data field");
        assert!(parsed2.get("data").is_some(), "Second item should have data field");

        // Verify order (should be by created_at ASC)
        let data1 = parsed1.get("data").unwrap();
        let data2 = parsed2.get("data").unwrap();

        assert_eq!(data1.get("name").and_then(|v| v.as_str()), Some("Alice"));
        assert_eq!(data2.get("name").and_then(|v| v.as_str()), Some("Bob"));

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_export_collection_jsonl_empty() {
        let (state, project_dir) = create_test_database().await;

        // Create job and collection without items
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("test_job")
        .bind("/path/to/prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("completed")
        .execute(&state.pool())
        .await
        .expect("Failed to insert job");

        let job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&state.pool())
            .await
            .expect("Failed to get job ID");

        let collection_id: i64 =
            sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
                .bind(job_id)
                .bind("empty_collection")
                .fetch_one(&state.pool())
                .await
                .expect("Failed to create collection");

        // Export empty collection
        let result = export_collection_jsonl_by_id(&state.pool(), collection_id).await;
        assert!(result.is_ok(), "Export should succeed: {:?}", result.err());

        let jsonl_content = result.unwrap();
        assert_eq!(jsonl_content, "", "Empty collection should return empty string");

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_export_collection_jsonl_nonexistent() {
        let (state, project_dir) = create_test_database().await;

        // Try to export non-existent collection
        let result = export_collection_jsonl_by_id(&state.pool(), 99999).await;
        assert!(result.is_err(), "Export should fail for non-existent collection");
        assert!(result.unwrap_err().contains("Collection not found"));

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_export_collection_csv() {
        let (state, project_dir) = create_test_database().await;

        // Create job and collection
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("test_job")
        .bind("/path/to/prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("completed")
        .execute(&state.pool())
        .await
        .expect("Failed to insert job");

        let job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&state.pool())
            .await
            .expect("Failed to get job ID");

        let collection_id: i64 =
            sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
                .bind(job_id)
                .bind("test_collection")
                .fetch_one(&state.pool())
                .await
                .expect("Failed to create collection");

        // Add items with different data
        sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?, ?)")
            .bind(collection_id)
            .bind(r#"{"name": "Alice", "age": 30}"#)
            .execute(&state.pool())
            .await
            .expect("Failed to insert item 1");

        sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?, ?)")
            .bind(collection_id)
            .bind(r#"{"name": "Bob", "age": 25}"#)
            .execute(&state.pool())
            .await
            .expect("Failed to insert item 2");

        // Export as CSV
        let result = export_collection_csv_by_id(&state.pool(), collection_id).await;
        assert!(result.is_ok(), "Export should succeed: {:?}", result.err());

        let csv_content = result.unwrap();
        let lines: Vec<&str> = csv_content.lines().collect();

        assert_eq!(lines.len(), 3, "Should have header + 2 data rows");

        // Verify header contains expected columns (order may vary due to BTreeSet)
        let header = lines[0];
        assert!(header.contains("name"), "Header should contain 'name' column");
        assert!(header.contains("age"), "Header should contain 'age' column");

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_export_collection_csv_with_special_chars() {
        let (state, project_dir) = create_test_database().await;

        // Create job and collection
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("test_job")
        .bind("/path/to/prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("completed")
        .execute(&state.pool())
        .await
        .expect("Failed to insert job");

        let job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&state.pool())
            .await
            .expect("Failed to get job ID");

        let collection_id: i64 =
            sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
                .bind(job_id)
                .bind("test_collection")
                .fetch_one(&state.pool())
                .await
                .expect("Failed to create collection");

        // Add item with special characters (comma, quotes, newline)
        sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?, ?)")
            .bind(collection_id)
            .bind(r#"{"name": "Smith, John", "quote": "He said \"hello\""}"#)
            .execute(&state.pool())
            .await
            .expect("Failed to insert item");

        // Export as CSV
        let result = export_collection_csv_by_id(&state.pool(), collection_id).await;
        assert!(result.is_ok(), "Export should succeed: {:?}", result.err());

        let csv_content = result.unwrap();
        // Should contain properly escaped quotes
        assert!(csv_content.contains("\"\""), "Should escape quotes with double quotes");

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_export_collection_csv_empty() {
        let (state, project_dir) = create_test_database().await;

        // Create job and collection without items
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("test_job")
        .bind("/path/to/prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("completed")
        .execute(&state.pool())
        .await
        .expect("Failed to insert job");

        let job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&state.pool())
            .await
            .expect("Failed to get job ID");

        let collection_id: i64 =
            sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
                .bind(job_id)
                .bind("empty_collection")
                .fetch_one(&state.pool())
                .await
                .expect("Failed to create collection");

        // Export empty collection
        let result = export_collection_csv_by_id(&state.pool(), collection_id).await;
        assert!(result.is_ok(), "Export should succeed: {:?}", result.err());

        let csv_content = result.unwrap();
        assert_eq!(csv_content, "", "Empty collection should return empty string");

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_export_collection_csv_nonexistent() {
        let (state, project_dir) = create_test_database().await;

        // Try to export non-existent collection
        let result = export_collection_csv_by_id(&state.pool(), 99999).await;
        assert!(result.is_err(), "Export should fail for non-existent collection");
        assert!(result.unwrap_err().contains("Collection not found"));

        cleanup_test_database(&project_dir);
    }

    #[tokio::test]
    async fn test_format_csv_value() {
        // Test null
        let null_val = serde_json::Value::Null;
        assert_eq!(format_csv_value(&null_val), "");

        // Test boolean
        let bool_val = serde_json::Value::Bool(true);
        assert_eq!(format_csv_value(&bool_val), "true");

        // Test number
        let num_val = serde_json::Value::Number(42.into());
        assert_eq!(format_csv_value(&num_val), "42");

        // Test simple string
        let str_val = serde_json::Value::String("hello".into());
        assert_eq!(format_csv_value(&str_val), "hello");

        // Test string with comma
        let comma_val = serde_json::Value::String("hello, world".into());
        let result = format_csv_value(&comma_val);
        assert!(result.starts_with('"') && result.ends_with('"'));

        // Test string with quotes
        let quote_val = serde_json::Value::String("he said \"hi\"".into());
        let result = format_csv_value(&quote_val);
        assert!(result.contains("\"\""));

        // Test array
        let arr_val = serde_json::json!([1, 2, 3]);
        let result = format_csv_value(&arr_val);
        assert!(result.starts_with('"') && result.ends_with('"'));

        // Test object
        let obj_val = serde_json::json!({"key": "value"});
        let result = format_csv_value(&obj_val);
        assert!(result.starts_with('"') && result.ends_with('"'));
    }

    async fn insert_job_with_status(state: &DatabaseState, name: &str, status: &str) -> i64 {
        sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(name)
        .bind("p.j2")
        .bind("d.jsonl")
        .bind("Local")
        .bind("m")
        .bind("http://x")
        .bind("Unstructured")
        .bind(1)
        .bind("Single")
        .bind(status)
        .execute(&state.pool())
        .await
        .expect("insert job");

        sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind(name)
            .fetch_one(&state.pool())
            .await
            .expect("get job id")
    }

    async fn insert_collection(state: &DatabaseState, job_id: i64, name: &str) -> i64 {
        sqlx::query_scalar("INSERT INTO collections (job_id, name) VALUES (?, ?) RETURNING id")
            .bind(job_id)
            .bind(name)
            .fetch_one(&state.pool())
            .await
            .expect("insert collection")
    }

    async fn insert_item(state: &DatabaseState, collection_id: i64, data: &str) {
        sqlx::query("INSERT INTO collection_items (collection_id, data) VALUES (?, ?)")
            .bind(collection_id)
            .bind(data)
            .execute(&state.pool())
            .await
            .expect("insert item");
    }

    #[tokio::test]
    async fn list_selectable_collections_includes_successful_terminal_jobs() {
        let (state, dir) = create_test_database().await;

        let done_job = insert_job_with_status(&state, "done", "completed").await;
        let mixed_job = insert_job_with_status(&state, "mixed", "completed_with_errors").await;
        let running_job = insert_job_with_status(&state, "running", "running").await;
        let failed_job = insert_job_with_status(&state, "failed", "failed").await;
        let cancelled_job = insert_job_with_status(&state, "cancelled", "cancelled").await;

        let done_col = insert_collection(&state, done_job, "done outputs").await;
        let mixed_col = insert_collection(&state, mixed_job, "mixed outputs").await;
        insert_item(&state, done_col, r#"{"a":1}"#).await;
        insert_item(&state, done_col, r#"{"a":2}"#).await;
        insert_item(&state, mixed_col, r#"{"a":3}"#).await;
        let _ = insert_collection(&state, running_job, "running outputs").await;
        let _ = insert_collection(&state, failed_job, "failed outputs").await;
        let _ = insert_collection(&state, cancelled_job, "cancelled outputs").await;

        let result = list_selectable_collections_with_pool(&state.pool()).await.expect("query");

        assert_eq!(result.len(), 2, "successful terminal collections should appear");
        assert!(result.iter().any(|c| c.name == "done outputs" && c.item_count == 2));
        assert!(result.iter().any(|c| c.name == "mixed outputs" && c.item_count == 1));

        cleanup_test_database(&dir);
    }

    #[tokio::test]
    async fn list_selectable_collections_empty_when_no_completed_jobs() {
        let (state, dir) = create_test_database().await;

        let pending = insert_job_with_status(&state, "pending", "pending").await;
        let _ = insert_collection(&state, pending, "pending outputs").await;

        let result = list_selectable_collections_with_pool(&state.pool()).await.expect("query");
        assert!(result.is_empty());

        cleanup_test_database(&dir);
    }
}
