pub mod file_ops;
pub mod inference;
pub mod orchestrator;
pub mod persistence;

// Re-export all Tauri commands for easy registration
pub use file_ops::*;
pub use inference::*;
pub use orchestrator::*;
pub use persistence::*;
