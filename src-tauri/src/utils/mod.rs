pub mod sanitization;
pub mod scanner;

// Re-export for convenience
pub use sanitization::sanitize_name;
pub use scanner::{is_text_file, scan_directory, MAX_ENTRIES_PER_DIR, MAX_SCAN_DEPTH};
