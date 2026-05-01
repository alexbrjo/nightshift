use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
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
    pub error_message: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct InferenceJobInput {
    pub name: String,
    #[serde(rename = "promptFile")]
    pub prompt_file: String,
    #[serde(rename = "dataSource")]
    pub data_source: String,
    pub provider: String,
    pub model: String,
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "outputMode")]
    pub output_mode: String,
    pub temperature: Option<f32>,
    #[serde(rename = "maxTokens")]
    pub max_tokens: Option<i32>,
    #[serde(rename = "thinkingBudget")]
    pub thinking_budget: Option<i32>,
    pub samples: i32,
    pub strategy: String,
    #[serde(rename = "preRenderUrl")]
    pub pre_render_url: Option<String>,
    #[serde(rename = "preRenderTimeout")]
    pub pre_render_timeout: Option<i32>,
    #[serde(rename = "preRenderBody")]
    pub pre_render_body: Option<String>,
    #[serde(rename = "jsonSchemaFile")]
    pub json_schema_file: Option<String>,
}

fn validate_inference_job_input(input: &InferenceJobInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Job name cannot be empty".to_string());
    }

    if input.samples <= 0 {
        return Err("Number of samples must be greater than 0".to_string());
    }

    if url::Url::parse(&input.server_url).is_err() {
        return Err(format!("Invalid server URL: {}", input.server_url));
    }

    if let Some(ref pre_render_url) = input.pre_render_url {
        if url::Url::parse(pre_render_url).is_err() {
            return Err(format!("Invalid pre-render URL: {}", pre_render_url));
        }
    }

    Ok(())
}

/// Database connection state.
///
/// The pool is held behind an `Arc<RwLock<...>>` so it can be hot-swapped when
/// the user opens a different project — every command reads through `pool()`
/// to grab a fresh clone, while `reconnect(path)` atomically replaces the
/// underlying connection. `reconnect_lock` serializes concurrent reconnects so
/// the no-op-if-same-project check can't race with the write.
#[derive(Clone)]
pub struct DatabaseState {
    pool: Arc<RwLock<SqlitePool>>,
    pub project_root: Arc<Mutex<PathBuf>>,
    reconnect_lock: Arc<tokio::sync::Mutex<()>>,
}

impl DatabaseState {
    /// Find the project root by looking for .nightshift directory
    /// Returns the project root path or an error if not found
    pub fn find_project_root<P: AsRef<Path>>(start_path: P) -> Result<PathBuf, String> {
        let mut current = start_path.as_ref().to_path_buf();

        // If start_path is a file, get its parent
        if current.is_file() {
            current = current.parent().ok_or("Path has no parent directory")?.to_path_buf();
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

    /// Resolve project root for `start_path`. The opened folder must be the
    /// project root itself: either it already contains `.nightshift/`, or no
    /// ancestor does (in which case `.nightshift/` is initialized there).
    /// Opening a subfolder of an existing project is rejected so that the
    /// app's notion of the project root and the database's never diverge.
    pub async fn ensure_project_root<P: AsRef<Path>>(start_path: P) -> Result<PathBuf, String> {
        let mut root = start_path.as_ref().to_path_buf();
        if root.is_file() {
            root = root.parent().ok_or("Path has no parent directory")?.to_path_buf();
        }

        let here = root.join(".nightshift");
        if here.exists() && here.is_dir() {
            return Ok(root);
        }

        // No `.nightshift/` here. If an ancestor has one, the user opened a
        // subfolder of an existing project — refuse and tell them where the
        // real root is.
        let mut cursor = root.clone();
        while let Some(parent) = cursor.parent() {
            if parent == cursor {
                break;
            }
            let ancestor_marker = parent.join(".nightshift");
            if ancestor_marker.exists() && ancestor_marker.is_dir() {
                return Err(format!(
                    "{} is inside an existing Nightshift project at {}. Open the project root directly.",
                    root.display(),
                    parent.display()
                ));
            }
            cursor = parent.to_path_buf();
        }

        // No `.nightshift/` here or above — initialize a fresh project here.
        tokio::fs::create_dir_all(root.join(".nightshift"))
            .await
            .map_err(|e| format!("Failed to create .nightshift directory: {}", e))?;
        Ok(root)
    }

    /// Open a connection at the project's `.nightshift/nightshift.db` and run
    /// all migrations. Used by both `new()` and `reconnect()`.
    async fn open_pool(project_root: &Path) -> Result<SqlitePool, sqlx::Error> {
        let db_path = Self::get_database_path(project_root);

        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        }

        tracing::info!(
            project_root = %project_root.display(),
            db_path = %db_path.display(),
            "opening project database"
        );
        let connection_string = format!(
            "file:{}?mode=rwc",
            db_path.display().to_string().replace(' ', "%20").replace('#', "%23")
        );
        let pool = SqlitePool::connect(&connection_string).await?;

        Self::run_migrations(&pool).await?;
        Ok(pool)
    }

    async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        sqlx::query("PRAGMA foreign_keys = ON").execute(pool).await?;

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
                error_message TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(pool)
        .await?;

        // Add error_message column to existing databases that predate it.
        if let Err(e) = sqlx::query("ALTER TABLE inference_jobs ADD COLUMN error_message TEXT")
            .execute(pool)
            .await
        {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL UNIQUE,
                name TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (job_id) REFERENCES inference_jobs(id) ON DELETE CASCADE
            )
            "#,
        )
        .execute(pool)
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
        .execute(pool)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_inference_jobs_status ON inference_jobs(status)",
        )
        .execute(pool)
        .await?;
        sqlx::query("DROP INDEX IF EXISTS idx_collections_job_id").execute(pool).await?;
        sqlx::query(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_job_id ON collections(job_id)",
        )
        .execute(pool)
        .await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id)")
            .execute(pool).await?;

        Ok(())
    }

    /// Initialize a database state with no project open yet. The pool is an
    /// in-memory SQLite (no filesystem footprint) so the app can boot before
    /// the user has chosen a project; commands that try to write data before
    /// `reconnect()` will succeed against this scratch DB and the data is
    /// discarded on the next reconnect. In practice no useful command runs
    /// before a project is opened.
    pub async fn empty() -> Result<Self, sqlx::Error> {
        let pool = SqlitePool::connect("sqlite::memory:").await?;
        Self::run_migrations(&pool).await?;
        Ok(Self {
            pool: Arc::new(RwLock::new(pool)),
            project_root: Arc::new(Mutex::new(PathBuf::new())),
            reconnect_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    /// Initialize the database connection and run migrations.
    pub async fn new<P: AsRef<Path>>(project_path: P) -> Result<Self, sqlx::Error> {
        let project_root = Self::ensure_project_root(project_path)
            .await
            .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        let pool = Self::open_pool(&project_root).await?;
        Ok(Self {
            pool: Arc::new(RwLock::new(pool)),
            project_root: Arc::new(Mutex::new(project_root)),
            reconnect_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    /// Get a clone of the current pool. SqlitePool is internally Arc-shared,
    /// so this is cheap. Callers should pass the result to sqlx by reference
    /// (e.g. `&state.pool()`).
    pub fn pool(&self) -> SqlitePool {
        self.pool.read().unwrap().clone()
    }

    /// Reconnect the database pool to a different project's `.nightshift/`.
    /// Creates the project's `.nightshift/` if it doesn't already exist.
    /// Atomically swaps the live pool so existing in-flight queries against
    /// the previous pool finish on their own. Concurrent calls coalesce: only
    /// one reconnect runs at a time, and a follower whose target matches the
    /// already-current project no-ops without re-opening the file.
    pub async fn reconnect<P: AsRef<Path>>(&self, project_path: P) -> Result<(), String> {
        let project_root = Self::ensure_project_root(project_path).await?;

        // Serialize concurrent reconnects so the same-project check can't race
        // with the project_root write.
        let _guard = self.reconnect_lock.lock().await;

        if *self.project_root.lock().unwrap() == project_root {
            return Ok(());
        }

        let new_pool = Self::open_pool(&project_root).await.map_err(|e| {
            format!("Failed to open database for {}: {}", project_root.display(), e)
        })?;

        let old_pool = {
            let mut pool = self.pool.write().unwrap();
            std::mem::replace(&mut *pool, new_pool)
        };
        tokio::spawn(async move {
            old_pool.close().await;
        });

        *self.project_root.lock().unwrap() = project_root;
        Ok(())
    }

    /// Get the current project root path
    pub fn get_project_root(&self) -> PathBuf {
        self.project_root.lock().unwrap().clone()
    }
}

// Include collection command tests
#[path = "database_collection_tests.rs"]
mod collection_commands_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
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

    #[tokio::test]
    async fn ensure_project_root_uses_self_when_marker_present() {
        let _guard = get_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let project_dir = env::temp_dir().join(format!("epr_self_{}", Uuid::new_v4()));
        fs::create_dir_all(project_dir.join(".nightshift")).unwrap();

        let result = DatabaseState::ensure_project_root(&project_dir).await;
        assert_eq!(result.unwrap(), project_dir);

        fs::remove_dir_all(&project_dir).ok();
    }

    #[tokio::test]
    async fn ensure_project_root_initializes_when_no_marker_anywhere() {
        let _guard = get_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let project_dir = env::temp_dir().join(format!("epr_init_{}", Uuid::new_v4()));
        fs::create_dir_all(&project_dir).unwrap();

        let result = DatabaseState::ensure_project_root(&project_dir).await;
        assert_eq!(result.as_ref().unwrap(), &project_dir);
        assert!(project_dir.join(".nightshift").is_dir());

        fs::remove_dir_all(&project_dir).ok();
    }

    #[tokio::test]
    async fn ensure_project_root_rejects_subfolder_of_existing_project() {
        let _guard = get_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let project_dir = env::temp_dir().join(format!("epr_sub_{}", Uuid::new_v4()));
        let sub = project_dir.join("nested").join("deep");
        fs::create_dir_all(project_dir.join(".nightshift")).unwrap();
        fs::create_dir_all(&sub).unwrap();

        let err = DatabaseState::ensure_project_root(&sub).await.unwrap_err();
        assert!(err.contains("inside an existing Nightshift project"), "got: {err}");
        assert!(!sub.join(".nightshift").exists(), "should not create marker in subfolder");

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

    fn valid_job_input() -> InferenceJobInput {
        InferenceJobInput {
            name: "test_job".to_string(),
            prompt_file: "prompt.jinja2".to_string(),
            data_source: "data.jsonl".to_string(),
            provider: "local".to_string(),
            model: "test-model".to_string(),
            server_url: "http://localhost:1234".to_string(),
            output_mode: "Unstructured".to_string(),
            temperature: None,
            max_tokens: None,
            thinking_budget: None,
            samples: 1,
            strategy: "single".to_string(),
            pre_render_url: None,
            pre_render_timeout: None,
            pre_render_body: None,
            json_schema_file: None,
        }
    }

    #[test]
    fn test_validate_inference_job_input_rejects_invalid_urls() {
        let mut invalid_server = valid_job_input();
        invalid_server.server_url = "not a url".to_string();
        assert!(validate_inference_job_input(&invalid_server).is_err());

        let mut invalid_pre_render = valid_job_input();
        invalid_pre_render.pre_render_url = Some("not a url".to_string());
        assert!(validate_inference_job_input(&invalid_pre_render).is_err());
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
        let pool = DatabaseState::new(&project_dir).await.expect("Failed to create database");

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
        .execute(&pool.pool())
        .await
        .expect("Failed to insert parent record");

        // Get the job ID
        let _job_id: i64 = sqlx::query_scalar("SELECT id FROM inference_jobs WHERE name = ?")
            .bind("test_job")
            .fetch_one(&pool.pool())
            .await
            .expect("Failed to get job ID");

        // Try to insert a collection with invalid job_id (should fail due to FK constraint)
        let result = sqlx::query("INSERT INTO collections (job_id, name) VALUES (?, ?)")
            .bind(99999) // Non-existent job ID
            .bind("test_collection")
            .execute(&pool.pool())
            .await;

        // Should fail because foreign key constraint is enforced
        assert!(
            result.is_err(),
            "Foreign key constraint should prevent inserting collection with invalid job_id"
        );

        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("FOREIGN KEY constraint failed")
                || err.to_string().contains("foreign key"),
            "Error should mention foreign key constraint: {}",
            err
        );

        // Cleanup
        sqlx::query("DELETE FROM inference_jobs").execute(&pool.pool()).await.ok();
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
        let pool = DatabaseState::new(&project_dir).await.expect("Failed to create database");

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
        .execute(&pool.pool())
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
        .execute(&pool.pool())
        .await;

        // Should fail because UNIQUE constraint is enforced
        assert!(result2.is_err(), "UNIQUE constraint should prevent duplicate job names");

        let err = result2.unwrap_err();
        assert!(
            err.to_string().contains("UNIQUE")
                || err.to_string().contains("unique")
                || err.to_string().contains("constraint"),
            "Error should mention unique constraint: {}",
            err
        );

        // Cleanup
        sqlx::query("DELETE FROM inference_jobs").execute(&pool.pool()).await.ok();
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
        let pool = DatabaseState::new(&project_dir).await.expect("Failed to create database");

        // Query sqlite_master to check if the index exists
        let index_exists: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='index' AND name='idx_collections_job_id'"
        )
        .fetch_one(&pool.pool())
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
    validate_inference_job_input(&input)?;

    tracing::info!(
        "Creating inference job: {} with prompt file: {}",
        input.name,
        input.prompt_file
    );

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
    .execute(&state.pool())
    .await;

    match result {
        Ok(result) => {
            tracing::info!(
                "Successfully created inference job with ID: {}",
                result.last_insert_rowid()
            );
            Ok(result.last_insert_rowid())
        }
        Err(e) => {
            let error_msg = format!("Failed to create inference job: {}", e);
            tracing::error!("{}", error_msg);

            // Check for unique constraint violation
            if e.to_string().contains("UNIQUE constraint failed") {
                return Err(format!(
                    "A job with the name '{}' already exists. Please choose a different name.",
                    input.name
                ));
            }

            Err(error_msg)
        }
    }
}

/// Internal helper to get an inference job by ID (works with SqlitePool directly)
pub async fn get_inference_job_by_id(
    pool: &SqlitePool,
    id: i64,
) -> Result<Option<InferenceJob>, String> {
    let job = sqlx::query_as::<_, InferenceJob>(
        r#"
        SELECT * FROM inference_jobs WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch inference job: {}", e))?;

    Ok(job)
}

/// Tauri command to get an inference job by ID
#[tauri::command]
pub async fn get_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
) -> Result<Option<InferenceJob>, String> {
    get_inference_job_by_id(&state.pool(), id).await
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
    .fetch_all(&state.pool())
    .await
    .map_err(|e| format!("Failed to list inference jobs: {}", e))?;

    Ok(jobs)
}

/// Internal helper to update an inference job (works with SqlitePool directly)
pub async fn update_inference_job_by_id(
    pool: &SqlitePool,
    id: i64,
    input: InferenceJobInput,
) -> Result<bool, String> {
    validate_inference_job_input(&input)?;

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
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update inference job: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Tauri command to update an inference job
#[tauri::command]
pub async fn update_inference_job(
    state: State<'_, DatabaseState>,
    id: i64,
    input: InferenceJobInput,
) -> Result<bool, String> {
    update_inference_job_by_id(&state.pool(), id, input).await
}

/// Update just the job status (internal helper)
pub async fn update_job_status(pool: &SqlitePool, id: i64, status: &str) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE inference_jobs
        SET status = ?, updated_at = datetime('now')
        WHERE id = ?
        "#,
    )
    .bind(status)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update job status: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Update job status with error message (internal helper)
pub async fn update_job_status_with_error(
    pool: &SqlitePool,
    id: i64,
    error: &str,
) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE inference_jobs
        SET status = 'failed', error_message = ?, updated_at = datetime('now')
        WHERE id = ?
        "#,
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update job status: {}", e))?;

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
    .execute(&state.pool())
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
    .fetch_one(&state.pool())
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
    .execute(&state.pool())
    .await
    .map_err(|e| format!("Failed to create collection: {}", e))?;

    Ok(result.last_insert_rowid())
}

/// Tauri command to get all collections for a job
#[tauri::command]
pub async fn get_collections_for_job(
    state: State<'_, DatabaseState>,
    job_id: i64,
) -> Result<Vec<Collection>, String> {
    sqlx::query_as::<_, Collection>(
        r#"
        SELECT id, job_id, name, created_at
        FROM collections
        WHERE job_id = ?
        ORDER BY created_at ASC
        "#,
    )
    .bind(job_id)
    .fetch_all(&state.pool())
    .await
    .map_err(|e| format!("Failed to get collections: {}", e))
}

/// Tauri command to list all collections
#[tauri::command]
pub async fn list_all_collections(
    state: State<'_, DatabaseState>,
) -> Result<Vec<Collection>, String> {
    sqlx::query_as::<_, Collection>(
        r#"
        SELECT id, job_id, name, created_at
        FROM collections
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(&state.pool())
    .await
    .map_err(|e| format!("Failed to list collections: {}", e))
}

/// Collection representation
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Collection {
    pub id: i64,
    pub job_id: i64,
    pub name: String,
    pub created_at: String,
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
    .fetch_one(&state.pool())
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
    .execute(&state.pool())
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
    .fetch_one(&state.pool())
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
    .fetch_all(&state.pool())
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
    .fetch_one(&state.pool())
    .await
    .map_err(|e| format!("Failed to get collection count: {}", e))?;

    Ok(count)
}

/// Tauri command to delete a collection item
#[tauri::command]
pub async fn delete_collection_item(
    state: State<'_, DatabaseState>,
    item_id: i64,
) -> Result<bool, String> {
    delete_collection_item_by_id(&state.pool(), item_id).await
}

pub(crate) async fn delete_collection_item_by_id(pool: &SqlitePool, item_id: i64) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        DELETE FROM collection_items WHERE id = ?
        "#,
    )
    .bind(item_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to delete collection item: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Export format for collection items
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionItemExport {
    pub id: i64,
    pub data: serde_json::Value,
    pub created_at: String,
}

/// Tauri command to export collection items as JSONL
#[tauri::command]
pub async fn export_collection_jsonl(
    state: State<'_, DatabaseState>,
    collection_id: i64,
) -> Result<String, String> {
    export_collection_jsonl_by_id(&state.pool(), collection_id).await
}

pub(crate) async fn export_collection_jsonl_by_id(
    pool: &SqlitePool,
    collection_id: i64,
) -> Result<String, String> {
    // Verify collection exists
    let collection_exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?)
        "#,
    )
    .bind(collection_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to check collection existence: {}", e))?;

    if !collection_exists {
        return Err("Collection not found".to_string());
    }

    let items = sqlx::query_as::<_, CollectionItem>(
        r#"
        SELECT * FROM collection_items
        WHERE collection_id = ?
        ORDER BY created_at ASC
        "#,
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch collection items: {}", e))?;

    // Convert to export format and serialize as JSONL
    let export_items: Vec<CollectionItemExport> = items
        .into_iter()
        .map(|item| CollectionItemExport {
            id: item.id,
            data: item.data,
            created_at: item.created_at,
        })
        .collect();

    let jsonl_lines: Result<Vec<String>, _> =
        export_items.iter().map(|item| serde_json::to_string(item)).collect();

    let jsonl_content =
        jsonl_lines.map_err(|e| format!("Failed to serialize items to JSONL: {}", e))?.join("\n");

    Ok(jsonl_content)
}

/// Tauri command to export collection items as CSV
#[tauri::command]
pub async fn export_collection_csv(
    state: State<'_, DatabaseState>,
    collection_id: i64,
) -> Result<String, String> {
    export_collection_csv_by_id(&state.pool(), collection_id).await
}

pub(crate) async fn export_collection_csv_by_id(
    pool: &SqlitePool,
    collection_id: i64,
) -> Result<String, String> {
    // Verify collection exists
    let collection_exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?)
        "#,
    )
    .bind(collection_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to check collection existence: {}", e))?;

    if !collection_exists {
        return Err("Collection not found".to_string());
    }

    let items = sqlx::query_as::<_, CollectionItem>(
        r#"
        SELECT * FROM collection_items
        WHERE collection_id = ?
        ORDER BY created_at ASC
        "#,
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch collection items: {}", e))?;

    if items.is_empty() {
        return Ok(String::new());
    }

    // Auto-detect columns from the first item's data
    let all_keys: std::collections::BTreeSet<String> = items
        .iter()
        .flat_map(|item| {
            if let serde_json::Value::Object(map) = &item.data {
                Box::new(map.keys().cloned()) as Box<dyn Iterator<Item = String>>
            } else {
                Box::new(std::iter::empty()) as Box<dyn Iterator<Item = String>>
            }
        })
        .collect();

    if all_keys.is_empty() {
        return Ok(String::new());
    }

    // Build CSV header
    let mut csv_lines = Vec::new();
    let headers: Vec<String> = all_keys.into_iter().collect();
    csv_lines.push(format!("id,{}", headers.join(",")));

    // Build CSV rows
    for item in items {
        let row_values: Vec<String> = headers
            .iter()
            .map(|key| {
                if let serde_json::Value::Object(map) = &item.data {
                    map.get(key).map(|v| format_csv_value(v)).unwrap_or_default()
                } else {
                    String::new()
                }
            })
            .collect();
        csv_lines.push(format!("{},{}", item.id, row_values.join(",")));
    }

    Ok(csv_lines.join("\n"))
}

/// Helper function to format a JSON value as a CSV-safe string
pub fn format_csv_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            // Escape quotes and wrap in quotes if contains comma, quote, or newline
            let escaped = s.replace('"', "\"\"");
            if escaped.contains(',') || escaped.contains('"') || escaped.contains('\n') {
                format!("\"{}\"", escaped)
            } else {
                escaped
            }
        }
        serde_json::Value::Array(arr) => {
            // Convert arrays to JSON string representation
            let arr_str = serde_json::to_string(arr).unwrap_or_default();
            format!("\"{}\"", arr_str.replace('"', "\"\""))
        }
        serde_json::Value::Object(obj) => {
            // Convert objects to JSON string representation
            let obj_str = serde_json::to_string(obj).unwrap_or_default();
            format!("\"{}\"", obj_str.replace('"', "\"\""))
        }
    }
}
