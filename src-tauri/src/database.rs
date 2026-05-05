//! `DatabaseState` — manages the per-project SQLite connection pool.
//!
//! After the orchestrator cutover this file holds only the connection-pool
//! lifecycle (open / reconnect / project-root resolution). All schema
//! definitions live in `migrations/`; all row types and CRUD live in
//! `orchestrator/`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use sqlx::SqlitePool;

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
    /// Find the project root by looking for the `.nightshift/` marker.
    pub fn find_project_root<P: AsRef<Path>>(start_path: P) -> Result<PathBuf, String> {
        let mut current = start_path.as_ref().to_path_buf();
        if current.is_file() {
            current = current.parent().ok_or("Path has no parent directory")?.to_path_buf();
        }
        loop {
            if current.join(".nightshift").is_dir() {
                return Ok(current);
            }
            match current.parent() {
                Some(parent) if parent != current => current = parent.to_path_buf(),
                _ => break,
            }
        }
        Err(format!(
            "Could not find project root (no .nightshift directory found starting from {})",
            start_path.as_ref().display()
        ))
    }

    pub fn get_database_path<P: AsRef<Path>>(project_root: P) -> PathBuf {
        let project_root_ref = project_root.as_ref();
        let abs_project_root = if project_root_ref.is_absolute() {
            project_root_ref.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(project_root_ref))
                .unwrap_or_else(|_| project_root_ref.to_path_buf())
        };
        abs_project_root.join(".nightshift").join("nightshift.db")
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

        if root.join(".nightshift").is_dir() {
            return Ok(root);
        }

        let mut cursor = root.clone();
        while let Some(parent) = cursor.parent() {
            if parent == cursor {
                break;
            }
            if parent.join(".nightshift").is_dir() {
                return Err(format!(
                    "{} is inside an existing Nightshift project at {}. \
                     Open the project root directly.",
                    root.display(),
                    parent.display()
                ));
            }
            cursor = parent.to_path_buf();
        }

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

        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await?;
        crate::migrations::run(&pool).await?;
        Ok(pool)
    }

    /// Initialize a database state with no project open yet. The pool is an
    /// in-memory SQLite (no filesystem footprint) so the app can boot before
    /// the user has chosen a project; commands that try to write data before
    /// `reconnect()` will succeed against this scratch DB and the data is
    /// discarded on the next reconnect. In practice no useful command runs
    /// before a project is opened.
    pub async fn empty() -> Result<Self, sqlx::Error> {
        let pool = SqlitePool::connect("sqlite::memory:").await?;
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await?;
        crate::migrations::run(&pool).await?;
        Ok(Self {
            pool: Arc::new(RwLock::new(pool)),
            project_root: Arc::new(Mutex::new(PathBuf::new())),
            reconnect_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

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
    /// so this is cheap. Callers should pass the result to sqlx by reference.
    pub fn pool(&self) -> SqlitePool {
        self.pool.read().unwrap().clone()
    }

    /// Reconnect the database pool to a different project's `.nightshift/`.
    /// Atomically swaps the live pool so existing in-flight queries against
    /// the previous pool finish on their own. Concurrent calls coalesce: only
    /// one reconnect runs at a time, and a follower whose target matches the
    /// already-current project no-ops without re-opening the file.
    pub async fn reconnect<P: AsRef<Path>>(&self, project_path: P) -> Result<(), String> {
        let project_root = Self::ensure_project_root(project_path).await?;
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

    pub fn get_project_root(&self) -> PathBuf {
        self.project_root.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::sync::OnceLock;
    use uuid::Uuid;

    static TEST_LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    fn get_test_lock() -> &'static Arc<Mutex<()>> {
        TEST_LOCK.get_or_init(|| Arc::new(Mutex::new(())))
    }

    #[test]
    fn test_find_project_root_finds_nightshift_directory() {
        let _guard = get_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let project_dir = env::temp_dir().join(format!("test_project_{}", Uuid::new_v4()));
        fs::create_dir_all(project_dir.join(".nightshift")).unwrap();
        let result = DatabaseState::find_project_root(&project_dir);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), project_dir);
        fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn test_find_project_root_searches_parent_directories() {
        let _guard = get_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let project_dir = env::temp_dir().join(format!("test_project_{}", Uuid::new_v4()));
        let deep = project_dir.join(".nightshift").join("subdir1").join("subdir2");
        fs::create_dir_all(&deep).unwrap();
        let result = DatabaseState::find_project_root(&deep);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), project_dir);
        fs::remove_dir_all(&project_dir).ok();
    }

    #[test]
    fn test_find_project_root_returns_error_when_no_nightshift() {
        let _guard = get_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let project_dir = env::temp_dir().join(format!("test_no_ns_{}", Uuid::new_v4()));
        fs::create_dir_all(&project_dir).unwrap();
        let result = DatabaseState::find_project_root(&project_dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Could not find project root"));
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
        fs::remove_dir_all(&project_dir).ok();
    }
}
