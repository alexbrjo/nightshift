use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::path::{Path, PathBuf};
use tauri::State;

/// Represents an inference job configuration
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct InferenceJob {
    pub id: i64,
    pub name: String,
    pub prompt_file: String,
    pub data_source: String,
    pub provider: String,
    pub model: String,
    pub server_url: String,
    pub output_mode: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<i32>,
    pub thinking_budget: Option<i32>,
    pub samples: i32,
    pub strategy: String,
    pub pre_render_url: Option<String>,
    pub pre_render_timeout: Option<i32>,
    pub pre_render_body: Option<String>,
    pub json_schema_file: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Represents a collection item (output from inference job)
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CollectionItem {
    pub id: i64,
    pub collection_id: i64,
    pub data: serde_json::Value,
    pub created_at: String,
}

/// Input parameters for creating/updating an inference job
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceJobInput {
    pub name: String,
    pub prompt_file: String,
    pub data_source: String,
    pub provider: String,
    pub model: String,
    pub server_url: String,
    pub output_mode: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<i32>,
    pub thinking_budget: Option<i32>,
    pub samples: i32,
    pub strategy: String,
    pub pre_render_url: Option<String>,
    pub pre_render_timeout: Option<i32>,
    pub pre_render_body: Option<String>,
    pub json_schema_file: Option<String>,
}

/// Database connection state
#[derive(Clone)]
pub struct DatabaseState {
    pub pool: SqlitePool,
}

impl DatabaseState {
    /// Find the project root by looking for .nightshift directory
    /// Returns the project root path or an error if not found
    pub fn find_project_root<P: AsRef<Path>>(start_path: P) -> Result<PathBuf, String> {
        let mut current = start_path.as_ref().to_path_buf();

        // If start_path is a file, get its parent
        if current.is_file() {
            current = current.parent()
                .ok_or("Path has no parent directory")?
                .to_path_buf();
        }

        // Walk up the directory tree looking for .nightshift
        loop {
            let nightshift_dir = current.join(".nightshift");
            if nightshift_dir.exists() && nightshift_dir.is_dir() {
                return Ok(current);
            }

            // Check if we've reached the filesystem root
            if let Some(parent) = current.parent() {
                if parent == current {
                    break; // Reached root
                }
                current = parent.to_path_buf();
            } else {
                break;
            }
        }

        Err(format!(
            "Could not find project root (no .nightshift directory found starting from {})",
            start_path.as_ref().display()
        ))
    }

    /// Get the database path for a given project
    pub fn get_database_path<P: AsRef<Path>>(project_root: P) -> PathBuf {
        let project_root_ref = project_root.as_ref();
        // Ensure we have an absolute path
        let abs_project_root = if project_root_ref.is_absolute() {
            project_root_ref.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(project_root_ref))
                .unwrap_or_else(|_| project_root_ref.to_path_buf())
        };
        let nightshift_dir = abs_project_root.join(".nightshift");
        nightshift_dir.join("nightshift.db")
    }

    /// Initialize the database connection and run migrations
    pub async fn new<P: AsRef<Path>>(project_path: P) -> Result<Self, sqlx::Error> {
        let project_path_ref = project_path.as_ref();

        // Find project root (directory containing .nightshift)
        let project_root = Self::find_project_root(project_path_ref)
            .map_err(|e| sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e
            )))?;

        // Get database path in .nightshift folder
        let db_path = Self::get_database_path(&project_root);

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent).await
                .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        }

        eprintln!("Project root: {}", project_root.display());
        eprintln!("Connecting to database at: {}", db_path.display());
        // Use file URI format with absolute path for better path handling on macOS
        let connection_string = format!("file:{}?mode=rwc",
            db_path.display().to_string().replace(' ', "%20").replace('#', "%23"));
        eprintln!("Connection string: {}", connection_string);
        let pool = SqlitePool::connect(&connection_string).await?;

        // Enable foreign key constraints
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await?;

        // Run migrations
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS inference_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                prompt_file TEXT NOT NULL,
                data_source TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                server_url TEXT NOT NULL,
                output_mode TEXT NOT NULL,
                temperature REAL,
                max_tokens INTEGER,
                thinking_budget INTEGER,
                samples INTEGER NOT NULL,
                strategy TEXT NOT NULL,
                pre_render_url TEXT,
                pre_render_timeout INTEGER,
                pre_render_body TEXT,
                json_schema_file TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (job_id) REFERENCES inference_jobs(id) ON DELETE CASCADE
            )
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS collection_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                data JSON NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            )
            "#,
        )
        .execute(&pool)
        .await?;

        // Create indexes for better query performance
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_inference_jobs_status ON inference_jobs(status)
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_collections_job_id ON collections(job_id)
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id)
            "#,
        )
        .execute(&pool)
        .await?;

          Ok(Self { pool })
      }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::env;
    use std::sync::{Arc, Mutex, OnceLock};
    use uuid::Uuid;

    // Global lock to prevent race conditions in file system tests
    static TEST_LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();

    fn get_test_lock() -> &'static Arc<Mutex<()>> {
        TEST_LOCK.get_or_init(|| Arc::new(Mutex::new(())))
    }

    #[test]
    fn test_find_project_root_finds_nightshift_directory() {
        // Acquire the global lock to prevent concurrent file system operations
        let _guard = get_test_lock().lock().unwrap();

        // Create a temporary directory structure: /tmp/test_proj/.nightshift/
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_project_{}", unique_id));
        let nightshift_dir = project_dir.join(".nightshift");

        fs::create_dir_all(&nightshift_dir).expect("Failed to create test directory");

        // Should find the project root
        let result = DatabaseState::find_project_root(&project_dir);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), project_dir);

        // Cleanup
        fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn test_find_project_root_searches_parent_directories() {
        // Acquire the global lock to prevent concurrent file system operations
        let _guard = get_test_lock().lock().unwrap_or_else(|e| e.into_inner());

        // Create: /tmp/test_proj/.nightshift/subdir1/subdir2
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_project_{}", unique_id));
        let nightshift_dir = project_dir.join(".nightshift");
        let deep_dir = nightshift_dir.join("subdir1").join("subdir2");

        fs::create_dir_all(&deep_dir).expect("Failed to create test directory");

        // Should find the project root even when starting from a subdirectory
        let result = DatabaseState::find_project_root(&deep_dir);
        assert!(result.is_ok(), "Should find project root: {:?}", result.err());
        assert_eq!(result.unwrap(), project_dir);

        // Cleanup
        fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn test_find_project_root_handles_file_paths() {
        // Acquire the global lock to prevent concurrent file system operations
        let _guard = get_test_lock().lock().unwrap();

        // Create: /tmp/test_proj/.nightshift/somefile.txt
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_project_{}", unique_id));
        let nightshift_dir = project_dir.join(".nightshift");
        let file_path = project_dir.join("somefile.txt");

        fs::create_dir_all(&nightshift_dir).expect("Failed to create test directory");
        fs::write(&file_path, "test").expect("Failed to create test file");

        // Should find the project root when given a file path
        let result = DatabaseState::find_project_root(&file_path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), project_dir);

        // Cleanup
        fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn test_find_project_root_returns_error_when_no_nightshift() {
        // Acquire the global lock to prevent concurrent file system operations
        let _guard = get_test_lock().lock().unwrap();

        // Create a unique temporary directory without .nightshift
        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_project_no_ns_{}", unique_id));

        fs::create_dir_all(&project_dir).expect("Failed to create test directory");

        // Should return an error because there's no .nightshift directory
        let result = DatabaseState::find_project_root(&project_dir);
        assert!(result.is_err(), "Should fail when no .nightshift directory exists");
        assert!(result.unwrap_err().contains("Could not find project root"));

        // Cleanup
        fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn test_get_database_path_returns_correct_location() {
        let temp_dir = env::temp_dir();
        let project_dir = temp_dir.join("test_project");

        let db_path = DatabaseState::get_database_path(&project_dir);

        assert_eq!(db_path, project_dir.join(".nightshift").join("nightshift.db"));
    }

    #[test]
    fn test_get_database_path_handles_unicode_paths() {
        let temp_dir = env::temp_dir();
        let project_dir = temp_dir.join("тест_проект");

        let db_path = DatabaseState::get_database_path(&project_dir);

        assert_eq!(db_path, project_dir.join(".nightshift").join("nightshift.db"));
    }

    #[tokio::test]
    async fn test_foreign_key_constraints_are_enabled() {
        // Acquire the global lock to prevent concurrent database operations
        let _guard = get_test_lock().lock().unwrap();

        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_fk_project_{}", unique_id));
        let nightshift_dir = project_dir.join(".nightshift");

        // Create .nightshift directory first
        fs::create_dir_all(&nightshift_dir).expect("Failed to create test directory");

        // Create database
        let pool = DatabaseState::new(&project_dir)
            .await
            .expect("Failed to create database");

        // Test that foreign key constraints are enforced
        // First, insert a parent record
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
        .execute(&pool.pool)
        .await
        .expect("Failed to insert parent record");

        // Get the job ID
        let _job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&pool.pool)
            .await
            .expect("Failed to get job ID");

        // Try to insert a collection with invalid job_id (should fail due to FK constraint)
        let result = sqlx::query(
            "INSERT INTO collections (job_id, name) VALUES (?, ?)"
        )
        .bind(99999) // Non-existent job ID
        .bind("test_collection")
        .execute(&pool.pool)
        .await;

        // Should fail because foreign key constraint is enforced
        assert!(result.is_err(), "Foreign key constraint should prevent inserting collection with invalid job_id");

        let err = result.unwrap_err();
        assert!(err.to_string().contains("FOREIGN KEY constraint failed") ||
                err.to_string().contains("foreign key"),
            "Error should mention foreign key constraint: {}", err);

        // Cleanup
        sqlx::query("DELETE FROM inference_jobs").execute(&pool.pool).await.ok();
        fs::remove_dir_all(&project_dir).ok();
    }

    #[tokio::test]
    async fn test_unique_constraint_on_job_names() {
        // Acquire the global lock to prevent concurrent database operations
        let _guard = get_test_lock().lock().unwrap();

        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_unique_project_{}", unique_id));
        let nightshift_dir = project_dir.join(".nightshift");

        // Create .nightshift directory first
        fs::create_dir_all(&nightshift_dir).expect("Failed to create test directory");

        // Create database
        let pool = DatabaseState::new(&project_dir)
            .await
            .expect("Failed to create database");

        // Insert first job with name "unique_test_job"
        let result1 = sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("unique_test_job")
        .bind("/path/to/prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("pending")
        .execute(&pool.pool)
        .await;

        assert!(result1.is_ok(), "First insert should succeed");

        // Try to insert another job with the same name (should fail due to UNIQUE constraint)
        let result2 = sqlx::query(
            "INSERT INTO inference_jobs (name, prompt_file, data_source, provider, model, server_url, output_mode, samples, strategy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("unique_test_job")
        .bind("/path/to/another_prompt.txt")
        .bind("/path/to/data.json")
        .bind("openai")
        .bind("gpt-4")
        .bind("https://api.openai.com/v1")
        .bind("text")
        .bind(5)
        .bind("exhaustive")
        .bind("pending")
        .execute(&pool.pool)
        .await;

        // Should fail because UNIQUE constraint is enforced
        assert!(result2.is_err(), "UNIQUE constraint should prevent duplicate job names");

        let err = result2.unwrap_err();
        assert!(err.to_string().contains("UNIQUE") ||
                err.to_string().contains("unique") ||
                err.to_string().contains("constraint"),
            "Error should mention unique constraint: {}", err);

        // Cleanup
        sqlx::query("DELETE FROM inference_jobs").execute(&pool.pool).await.ok();
        fs::remove_dir_all(&project_dir).ok();
    }

    #[tokio::test]
    async fn test_index_exists_on_collections_job_id() {
        // Acquire the global lock to prevent concurrent database operations
        let _guard = get_test_lock().lock().unwrap();

        let temp_dir = env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let project_dir = temp_dir.join(format!("test_index_project_{}", unique_id));
        let nightshift_dir = project_dir.join(".nightshift");

        // Create .nightshift directory first
        fs::create_dir_all(&nightshift_dir).expect("Failed to create test directory");

        // Create database
        let pool = DatabaseState::new(&project_dir)
            .await
            .expect("Failed to create database");

        // Query sqlite_master to check if the index exists
        let index_exists: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='index' AND name='idx_collections_job_id'"
        )
        .fetch_one(&pool.pool)
        .await
        .expect("Failed to query sqlite_master");

        assert!(index_exists, "Index 'idx_collections_job_id' should exist on collections table");

        // Cleanup
        fs::remove_dir_all(&project_dir).ok();
    }
}

/// Tauri command to create a new inference job
#[tauri::command]
pub async fn create_inference_job(
    state: State<'_, DatabaseState>,
    input: InferenceJobInput,
) -> Result<i64, String> {
    // Validate input
    if input.name.trim().is_empty() {
        return Err("Job name cannot be empty".to_string());
    }

    if input.samples <= 0 {
        return Err("Number of samples must be greater than 0".to_string());
    }

    let result = sqlx::query(
        r#"
        INSERT INTO inference_jobs (
            name, prompt_file, data_source, provider, model, server_url,
            output_mode, temperature, max_tokens, thinking_budget, samples, strategy,
            pre_render_url, pre_render_timeout, pre_render_body, json_schema_file, status
        )
        VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'pending'
        )
        "#,
    )
    .bind(&input.name)
    .bind(&input.prompt_file)
    .bind(&input.data_source)
    .bind(&input.provider)
    .bind(&input.model)
    .bind(&input.server_url)
    .bind(&input.output_mode)
    .bind(input.temperature)
    .bind(input.max_tokens)
    .bind(input.thinking_budget)
    .bind(input.samples)
    .bind(&input.strategy)
    .bind(&input.pre_render_url)
    .bind(input.pre_render_timeout)
    .bind(&input.pre_render_body)
    .bind(&input.json_schema_file)
    .execute(&state.pool)
    .await
    .map_err(|e| format!("Failed to create inference job: {}", e))?;

    Ok(result.last_insert_rowid())
}

/// Tauri command to get an inference job by ID
#[tauri::command]
pub async fn get_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
) -> Result<Option<InferenceJob>, String> {
    let job = sqlx::query_as::<_, InferenceJob>(
        r#"
        SELECT * FROM inference_jobs WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| format!("Failed to fetch inference job: {}", e))?;

    Ok(job)
}

/// Tauri command to list all inference jobs with pagination
#[tauri::command]
pub async fn list_inference_jobs(
    state: State<'_, DatabaseState>,
    page: i32,
    page_size: i32,
) -> Result<Vec<InferenceJob>, String> {
    let offset = (page - 1) * page_size;

    let jobs = sqlx::query_as::<_, InferenceJob>(
        r#"
        SELECT * FROM inference_jobs
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        "#,
    )
    .bind(page_size)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| format!("Failed to list inference jobs: {}", e))?;

    Ok(jobs)
}

/// Tauri command to update an inference job
#[tauri::command]
pub async fn update_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
    input: InferenceJobInput,
) -> Result<bool, String> {
    // Validate input
    if input.name.trim().is_empty() {
        return Err("Job name cannot be empty".to_string());
    }

    if input.samples <= 0 {
        return Err("Number of samples must be greater than 0".to_string());
    }

    let result = sqlx::query(
        r#"
        UPDATE inference_jobs SET
            name = ?1,
            prompt_file = ?2,
            data_source = ?3,
            provider = ?4,
            model = ?5,
            server_url = ?6,
            output_mode = ?7,
            temperature = ?8,
            max_tokens = ?9,
            thinking_budget = ?10,
            samples = ?11,
            strategy = ?12,
            pre_render_url = ?13,
            pre_render_timeout = ?14,
            pre_render_body = ?15,
            json_schema_file = ?16,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?17
        "#,
    )
    .bind(&input.name)
    .bind(&input.prompt_file)
    .bind(&input.data_source)
    .bind(&input.provider)
    .bind(&input.model)
    .bind(&input.server_url)
    .bind(&input.output_mode)
    .bind(input.temperature)
    .bind(input.max_tokens)
    .bind(input.thinking_budget)
    .bind(input.samples)
    .bind(&input.strategy)
    .bind(&input.pre_render_url)
    .bind(input.pre_render_timeout)
    .bind(&input.pre_render_body)
    .bind(&input.json_schema_file)
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(|e| format!("Failed to update inference job: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Tauri command to delete an inference job
#[tauri::command]
pub async fn delete_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        DELETE FROM inference_jobs WHERE id = ?
        "#,
    )
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(|e| format!("Failed to delete inference job: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Tauri command to create a collection for an inference job
#[tauri::command]
pub async fn create_collection(
    state: State<'_, DatabaseState>,
    job_id: i64,
    name: String,
) -> Result<i64, String> {
    // Verify job exists
    let job_exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(SELECT 1 FROM inference_jobs WHERE id = ?)
        "#,
    )
    .bind(job_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| format!("Failed to check job existence: {}", e))?;

    if !job_exists {
        return Err("Inference job not found".to_string());
    }

    let result = sqlx::query(
        r#"
        INSERT INTO collections (job_id, name)
        VALUES (?1, ?2)
        "#,
    )
    .bind(job_id)
    .bind(name)
    .execute(&state.pool)
    .await
    .map_err(|e| format!("Failed to create collection: {}", e))?;

    Ok(result.last_insert_rowid())
}

/// Tauri command to add an item to a collection
#[tauri::command]
pub async fn add_collection_item(
    state: State<'_, DatabaseState>,
    collection_id: i64,
    data: serde_json::Value,
) -> Result<i64, String> {
    // Verify collection exists
    let collection_exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?)
        "#,
    )
    .bind(collection_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| format!("Failed to check collection existence: {}", e))?;

    if !collection_exists {
        return Err("Collection not found".to_string());
    }

    let result = sqlx::query(
        r#"
        INSERT INTO collection_items (collection_id, data)
        VALUES (?1, ?2)
        "#,
    )
    .bind(collection_id)
    .bind(data)
    .execute(&state.pool)
    .await
    .map_err(|e| format!("Failed to add collection item: {}", e))?;

    Ok(result.last_insert_rowid())
}

/// Tauri command to get collection items with pagination
#[tauri::command]
pub async fn get_collection_items(
    state: State<'_, DatabaseState>,
    collection_id: i64,
    page: i32,
    page_size: i32,
) -> Result<Vec<CollectionItem>, String> {
    // Verify collection exists
    let collection_exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?)
        "#,
    )
    .bind(collection_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| format!("Failed to check collection existence: {}", e))?;

    if !collection_exists {
        return Err("Collection not found".to_string());
    }

    let offset = (page - 1) * page_size;

    let items = sqlx::query_as::<_, CollectionItem>(
        r#"
        SELECT * FROM collection_items
        WHERE collection_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        "#,
    )
    .bind(collection_id)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| format!("Failed to fetch collection items: {}", e))?;

    Ok(items)
}

/// Tauri command to get collection count
#[tauri::command]
pub async fn get_collection_count(
    state: State<'_, DatabaseState>,
    collection_id: i64,
) -> Result<i64, String> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*) FROM collection_items WHERE collection_id = ?
        "#,
    )
    .bind(collection_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| format!("Failed to get collection count: {}", e))?;

    Ok(count)
}
