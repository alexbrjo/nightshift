pub mod scanner;
pub mod sanitization;

// Re-export for convenience
pub use scanner::{is_text_file, scan_directory, MAX_SCAN_DEPTH, MAX_ENTRIES_PER_DIR};
pub use sanitization::sanitize_name;
