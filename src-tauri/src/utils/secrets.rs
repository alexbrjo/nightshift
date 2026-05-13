const SENSITIVE_KEY_PARTS: &[&str] = &[
    "api_key",
    "apikey",
    "password",
    "passwd",
    "pwd",
    "secret",
    "access_token",
    "refresh_token",
    "bearer_token",
    "authorization",
    "token",
];

pub(crate) fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.replace(['-', ' '], "_").to_ascii_lowercase();
    SENSITIVE_KEY_PARTS.iter().any(|sensitive| {
        if *sensitive == "token" {
            normalized.split('_').any(|part| part == "token")
        } else {
            normalized.contains(sensitive)
        }
    })
}

pub(crate) fn looks_like_secret_value(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("bearer ") || lower.starts_with("basic ") {
        return true;
    }
    if trimmed.starts_with("sk-")
        || trimmed.starts_with("sk_")
        || trimmed.starts_with("pk-")
        || trimmed.starts_with("nskey-")
    {
        return true;
    }
    if looks_like_jwt(trimmed) {
        return true;
    }
    looks_like_punctuated_oauth_token(trimmed)
}

fn looks_like_jwt(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts[0].starts_with("eyJ")
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        })
}

fn looks_like_punctuated_oauth_token(value: &str) -> bool {
    if value.chars().any(|ch| ch.is_whitespace()) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if !lower.starts_with("ya29.") && value.len() < 48 {
        return false;
    }
    let has_alpha = value.chars().any(|ch| ch.is_ascii_alphabetic());
    let has_digit = value.chars().any(|ch| ch.is_ascii_digit());
    let has_token_punctuation = value.chars().any(|ch| matches!(ch, '.' | '/' | '='));
    has_alpha
        && has_digit
        && has_token_punctuation
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | '='))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_detection_preserves_hash_like_identifiers() {
        assert!(!looks_like_secret_value("0123456789abcdef0123456789abcdef01234567"));
        assert!(!looks_like_secret_value("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn secret_detection_catches_bare_jwts_and_oauth_tokens() {
        assert!(looks_like_secret_value(
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ"
        ));
        assert!(looks_like_secret_value("ya29.a0AfH6SMB1234567890abcdef/abcdefghi="));
    }

    #[test]
    fn sensitive_keys_allow_common_variants() {
        assert!(is_sensitive_key("api-key"));
        assert!(is_sensitive_key("refresh token"));
        assert!(is_sensitive_key("providerSecret"));
        assert!(!is_sensitive_key("max_tokens"));
    }
}
