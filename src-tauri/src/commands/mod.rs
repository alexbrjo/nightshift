pub mod file_ops;
pub mod files;
pub mod orchestrator;
pub mod persistence;

// Re-export all Tauri commands for easy registration
pub use file_ops::*;
pub use files::*;
pub use orchestrator::*;
pub use persistence::*;
