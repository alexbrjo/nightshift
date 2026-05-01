/// Sanitize a filename by removing invalid characters
pub fn sanitize_name(name: &str) -> Result<String, String> {
    let sanitized = name.replace('\0', "");
    if sanitized.contains("..") || sanitized != name && name.contains('\0') {
        return Err("Invalid name: contains null bytes or \"..\" sequence".to_string());
    }
    if sanitized.contains('/') || sanitized.contains('\\') {
        return Err("Invalid name: contains path separators".to_string());
    }
    if sanitized.is_empty() {
        return Err("Invalid name: empty after sanitization".to_string());
    }
    Ok(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_rejects_null_bytes() {
        assert!(sanitize_name("foo\0bar").is_err());
    }

    #[test]
    fn sanitize_name_rejects_dotdot() {
        assert!(sanitize_name("foo/../bar").is_err());
        assert!(sanitize_name("..").is_err());
        assert!(sanitize_name("foo..bar").is_err()); // ".." anywhere is rejected
    }

    #[test]
    fn sanitize_name_rejects_path_separators() {
        assert!(sanitize_name("foo/bar").is_err());
        assert!(sanitize_name("foo\\bar").is_err());
    }

    #[test]
    fn sanitize_name_rejects_empty() {
        assert!(sanitize_name("").is_err());
    }

    #[test]
    fn sanitize_name_accepts_valid_names() {
        assert_eq!(sanitize_name("valid_file.txt").unwrap(), "valid_file.txt");
        assert_eq!(sanitize_name(".env").unwrap(), ".env");
        assert_eq!(sanitize_name("folder-name").unwrap(), "folder-name");
    }

    #[test]
    fn sanitize_name_strips_null_bytes() {
        let result = sanitize_name("foo\0bar");
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_name_handles_only_null_bytes() {
        assert!(sanitize_name("\0\0").is_err());
    }

    #[test]
    fn sanitize_name_handles_unicode() {
        assert!(sanitize_name("файл.txt").is_ok());
        assert!(sanitize_name("文件.md").is_ok());
    }

    #[test]
    fn sanitize_name_handles_special_chars() {
        assert!(sanitize_name("file-name.txt").is_ok());
        assert!(sanitize_name("file_name.txt").is_ok());
        assert!(sanitize_name(".hidden").is_ok());
    }
}
