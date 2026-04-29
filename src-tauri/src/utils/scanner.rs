use std::path::Path;

const TEXT_EXTENSIONS: &[&str] =
    &["js", "json", "jsonl", "yaml", "yml", "csv", "md", "markdown", "txt", "jinja", "jinja2"];

/// Maximum depth for directory scanning to prevent infinite recursion
pub const MAX_SCAN_DEPTH: u32 = 12;

/// Maximum number of files to scan before aborting (prevents node_modules scans)
pub const MAX_ENTRIES_PER_DIR: usize = 1_000;

/// Check if a file has a text-based extension
pub fn is_text_file(filename: &str) -> bool {
    if let Some(ext) = filename.rsplit('.').next() {
        return TEXT_EXTENSIONS.contains(&ext.to_lowercase().as_str());
    }
    false
}

/// Recursively scan a directory and return a JSON tree structure
pub fn scan_directory(
    dir: &Path,
    depth: u32,
    file_count: &mut usize,
) -> Result<Vec<serde_json::Value>, String> {
    if depth > MAX_SCAN_DEPTH {
        return Err(format!("Maximum directory scan depth ({}) exceeded", MAX_SCAN_DEPTH));
    }

    let mut entries = Vec::new();

    for entry in std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        if metadata.is_dir() {
            let children = scan_directory(&path, depth + 1, file_count)?;
            entries.push(serde_json::json!({
                "name": name,
                "isDir": true,
                "children": children,
            }));
        } else if is_text_file(&name) {
            *file_count += 1;
            if *file_count > MAX_ENTRIES_PER_DIR {
                return Err(format!(
                    "Too many files scanned (limit: {}). Directory may contain node_modules or similar.",
                    MAX_ENTRIES_PER_DIR
                ));
            }
            entries.push(serde_json::json!({
                "name": name,
                "isDir": false,
            }));
        }
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        let a_dir = a["isDir"].as_bool().unwrap_or(false);
        let b_dir = b["isDir"].as_bool().unwrap_or(false);
        if a_dir != b_dir {
            return if a_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn is_text_file_returns_true_for_known_extensions() {
        assert!(is_text_file("file.js"));
        assert!(is_text_file("file.json"));
        assert!(is_text_file("file.jsonl"));
        assert!(is_text_file("file.yaml"));
        assert!(is_text_file("file.yml"));
        assert!(is_text_file("file.csv"));
        assert!(is_text_file("file.md"));
        assert!(is_text_file("file.markdown"));
        assert!(is_text_file("file.txt"));
        assert!(is_text_file("file.jinja"));
        assert!(is_text_file("file.jinja2"));
    }

    #[test]
    fn is_text_file_returns_false_for_binary_extensions() {
        assert!(!is_text_file("file.png"));
        assert!(!is_text_file("file.jpg"));
        assert!(!is_text_file("file.exe"));
        assert!(!is_text_file("file.zip"));
        assert!(!is_text_file("file.pdf"));
    }

    #[test]
    fn is_text_file_returns_false_for_no_extension() {
        assert!(!is_text_file("README"));
        assert!(!is_text_file(".gitignore"));
    }

    #[test]
    fn is_text_file_handles_uppercase_extensions() {
        assert!(is_text_file("file.TXT"));
        assert!(is_text_file("file.JSON"));
        assert!(is_text_file("file.MD"));
    }

    #[test]
    fn is_text_file_handles_multiple_dots() {
        assert!(is_text_file("file.test.js"));
        assert!(is_text_file("data.backup.json"));
    }

    #[test]
    fn scan_directory_respects_depth_limit() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let deep_path = dir.join(format!("nightshift_depth_test_{}", unique_id));
        let mut current = deep_path.clone();
        for i in 0..=MAX_SCAN_DEPTH {
            current = current.join(format!("level_{}", i));
        }
        fs::create_dir_all(&current).ok();

        let result = scan_directory(&deep_path, 0, &mut 0usize);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Maximum directory scan depth"));

        fs::remove_dir_all(&deep_path).ok();
    }

    #[test]
    fn scan_directory_respects_file_count_limit() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_count_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        for i in 0..=MAX_ENTRIES_PER_DIR {
            fs::write(test_dir.join(format!("file_{}.txt", i)), "").ok();
        }

        let result = scan_directory(&test_dir, 0, &mut 0usize);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Too many files scanned"));

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_succeeds_within_limits() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_ok_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        fs::write(test_dir.join("a.txt"), "").ok();
        fs::write(test_dir.join("b.json"), "").ok();
        fs::create_dir_all(test_dir.join("subdir")).ok();
        fs::write(test_dir.join("subdir").join("c.md"), "").ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let _entries = result.unwrap();
        assert_eq!(count, 3); // a.txt, b.json, subdir/c.md

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_sorts_directories_first() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_sort_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        fs::write(test_dir.join("b.txt"), "").ok();
        fs::write(test_dir.join("a.txt"), "").ok();
        fs::create_dir_all(test_dir.join("z_dir")).ok();
        fs::create_dir_all(test_dir.join("a_dir")).ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let entries = result.unwrap();

        // Directories should come first, then files, both alphabetical
        assert!(entries[0]["isDir"].as_bool().unwrap());
        assert_eq!(entries[0]["name"].as_str().unwrap(), "a_dir");
        assert!(entries[1]["isDir"].as_bool().unwrap());
        assert_eq!(entries[1]["name"].as_str().unwrap(), "z_dir");
        assert!(!entries[2]["isDir"].as_bool().unwrap());
        assert_eq!(entries[2]["name"].as_str().unwrap(), "a.txt");

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_handles_empty_directory() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_empty_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 0);
        assert_eq!(count, 0);

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_skips_binary_files() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_binary_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        fs::write(test_dir.join("file.txt"), "").ok();
        fs::write(test_dir.join("image.png"), "").ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 1); // Only .txt should appear
        assert_eq!(count, 1);

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn scan_directory_handles_nested_directories() {
        let dir = std::env::temp_dir();
        let unique_id = Uuid::new_v4().to_string();
        let test_dir = dir.join(format!("nightshift_nested_test_{}", unique_id));
        fs::create_dir_all(&test_dir).ok();

        fs::create_dir_all(test_dir.join("a").join("b").join("c")).ok();
        fs::write(test_dir.join("a").join("b").join("c").join("deep.txt"), "content").ok();

        let mut count = 0usize;
        let result = scan_directory(&test_dir, 0, &mut count);
        assert!(result.is_ok());
        let _entries = result.unwrap();
        assert_eq!(count, 1);

        fs::remove_dir_all(&test_dir).ok();
    }
}
