use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::path::Path;
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
    pool: SqlitePool,
}

impl DatabaseState {
    /// Initialize the database connection and run migrations
    pub async fn new<P: AsRef<Path>>(db_path: P) -> Result<Self, sqlx::Error> {
        let db_path_ref = db_path.as_ref();
        
        // Ensure parent directory exists
        if let Some(parent) = db_path_ref.parent() {
            tokio::fs::create_dir_all(parent).await
                .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        }
        
        eprintln!("Connecting to database at: {}", db_path_ref.display());
        // Use file URI format for better path handling on macOS
        let connection_string = format!("file:{}?mode=rwc", 
            db_path_ref.display().to_string().replace(' ', "%20").replace('#', "%23"));
        eprintln!("Connection string: {}", connection_string);
        let pool = SqlitePool::connect(&connection_string).await?;
        
        // Run migrations
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS inference_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
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
            CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id)
            "#,
        )
        .execute(&pool)
        .await?;

          Ok(Self { pool })
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