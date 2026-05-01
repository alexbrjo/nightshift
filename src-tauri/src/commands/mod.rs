pub mod file_ops;
pub mod inference;
pub mod persistence;

// Re-export all Tauri commands for easy registration
pub use file_ops::*;
pub use inference::*;
pub use persistence::*;
