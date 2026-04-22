use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Project not found: {0}")]
    ProjectNotFound(String),
    #[error("Collection not found: {0}")]
    CollectionNotFound(String),
    #[error("Job not found: {0}")]
    JobNotFound(String),
    #[error("Template error: {0}")]
    Template(#[from] minijinja::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JS error: {0}")]
    Js(#[from] rquickjs::Error),
}

pub type Result<T> = std::result::Result<T, DbError>;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub project_path: Option<String>,
}

impl AppState {
    pub async fn initialize() -> Result<Self> {
        let db_path = "sqlite:./nightshift.db?mode=rwc".to_string();

        let pool = SqlitePool::connect(&db_path).await?;
        
        Self::migrate(&pool).await?;
        
        Ok(Self {
            pool,
            project_path: None,
        })
    }

    pub async fn new(project_path: Option<&str>) -> Result<Self> {
        let db_path = match project_path {
            Some(path) => format!("{}/.nightshift/db.sqlite", path),
            None => ":memory:".to_string(),
        };

        let pool = SqlitePool::connect(&db_path).await?;
        
        Self::migrate(&pool).await?;
        
        Ok(Self {
            pool,
            project_path: project_path.map(String::from),
        })
    }

    async fn migrate(pool: &SqlitePool) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                schema_json TEXT,
                item_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS collection_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                data_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (collection_id) REFERENCES collections(id)
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                job_type TEXT NOT NULL,
                config_json TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                progress REAL DEFAULT 0,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                started_at DATETIME,
                completed_at DATETIME,
                FOREIGN KEY (project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS job_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                sample_index INTEGER NOT NULL,
                rendered_prompt TEXT,
                raw_response TEXT,
                parsed_content TEXT,
                token_usage INTEGER DEFAULT 0,
                latency_ms INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (job_id) REFERENCES jobs(id)
            );

            CREATE TABLE IF NOT EXISTS pipelines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                definition_yaml TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS pipeline_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pipeline_id INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                progress REAL DEFAULT 0,
                current_stage TEXT,
                metrics_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                started_at DATETIME,
                completed_at DATETIME,
                FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
            );

            CREATE TABLE IF NOT EXISTS analysis_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                experiment_run_id INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                analysis_md TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                FOREIGN KEY (experiment_run_id) REFERENCES pipeline_runs(id)
            );

            CREATE INDEX IF NOT EXISTS idx_collection_items_collection 
                ON collection_items(collection_id);
            CREATE INDEX IF NOT EXISTS idx_job_samples_job 
                ON job_samples(job_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_project_status 
                ON jobs(project_id, status);
            "#,
        )
        .execute(pool)
        .await?;

        Ok(())
    }
}
