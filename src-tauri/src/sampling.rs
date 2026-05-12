use rand::prelude::SliceRandom;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::database::DatabaseState;

/// Sampling strategy for job execution. The number of samples is supplied
/// separately so the same strategy type can be reused by inference, transform,
/// and standalone sample jobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SamplingStrategy {
    Single,
    Random,
    Exhaustive,
}

impl std::str::FromStr for SamplingStrategy {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "single" => Ok(SamplingStrategy::Single),
            "random" | "random_samples" => Ok(SamplingStrategy::Random),
            "exhaustive" | "all" => Ok(SamplingStrategy::Exhaustive),
            _ => Err(format!("Unknown sampling strategy: {}", s)),
        }
    }
}

/// Load samples from a data source, either a project-relative file path or a
/// `collection:<id>` reference, and then apply the requested strategy.
pub async fn load_samples(
    db: &DatabaseState,
    data_source: &str,
    strategy: &SamplingStrategy,
    limit: i32,
) -> Result<Vec<serde_json::Value>, String> {
    debug!("Loading samples from data source: {} with strategy: {:?}", data_source, strategy);

    let samples = if let Some(rest) = data_source.strip_prefix("collection:") {
        let id: i64 = rest.parse().map_err(|_| format!("Invalid collection id: {}", rest))?;
        load_collection_samples(db, id).await?
    } else {
        load_file_samples(db, data_source).await?
    };

    debug!("Loaded {} samples from {}", samples.len(), data_source);

    if let Some(first) = samples.first() {
        debug!("First sample keys: {:?}", first.as_object().map(|o| o.keys().collect::<Vec<_>>()));
        debug!("First sample content: {:?}", first);
    } else {
        warn!("No samples loaded from data source!");
    }

    Ok(apply_strategy(samples, strategy, limit))
}

async fn load_file_samples(
    db: &DatabaseState,
    data_source: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let full_path = resolve_within_project(&db.get_project_root(), data_source)?;
    debug!("Full data source path: {}", full_path.display());

    let content = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|e| format!("Failed to read data source {}: {}", data_source, e))?;

    let mut samples: Vec<serde_json::Value> = Vec::new();

    if content.trim().starts_with('[') {
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse JSON array from {}: {}", data_source, e))?;
        samples = parsed;
    } else {
        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            match serde_json::from_str(trimmed) {
                Ok(obj) => samples.push(obj),
                Err(e) => {
                    warn!("Failed to parse line {} in {}: {}", line_num + 1, data_source, e);
                }
            }
        }
    }

    Ok(samples)
}

fn resolve_within_project(
    root: &std::path::Path,
    user_path: &str,
) -> Result<std::path::PathBuf, String> {
    use std::path::{Component, Path};

    let path = Path::new(user_path);
    if path.is_absolute() {
        return Err(format!("Absolute paths are not allowed: {}", user_path));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("Path may not contain '..': {}", user_path));
    }

    let root_canonical = std::fs::canonicalize(root)
        .map_err(|e| format!("Failed to resolve project root {}: {}", root.display(), e))?;
    let full = root_canonical.join(path);
    let full_canonical = std::fs::canonicalize(&full)
        .map_err(|e| format!("Failed to resolve path {}: {}", full.display(), e))?;

    if !full_canonical.starts_with(&root_canonical) {
        return Err(format!("Path escapes project root: {}", user_path));
    }
    Ok(full_canonical)
}

pub async fn load_collection_samples(
    db: &DatabaseState,
    collection_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let source_status = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT j.status
        FROM collections c
        JOIN inference_jobs j ON j.id = c.job_id
        WHERE c.id = ?
        "#,
    )
    .bind(collection_id)
    .fetch_optional(&db.pool())
    .await
    .map_err(|e| format!("Failed to check collection eligibility: {}", e))?
    .flatten();

    match source_status.as_deref() {
        None => {
            return Err(format!("Collection no longer exists (id={})", collection_id));
        }
        Some("completed") => {}
        Some(other) => {
            return Err(format!(
                "Collection {} is not usable as a data source: source job is {}",
                collection_id, other
            ));
        }
    }

    let rows = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT data FROM collection_items WHERE collection_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(collection_id)
    .fetch_all(&db.pool())
    .await
    .map_err(|e| format!("Failed to load collection items: {}", e))?;

    Ok(rows.into_iter().map(parse_content_field).collect())
}

pub fn apply_strategy(
    samples: Vec<serde_json::Value>,
    strategy: &SamplingStrategy,
    limit: i32,
) -> Vec<serde_json::Value> {
    match strategy {
        SamplingStrategy::Single => samples.into_iter().next().map(|s| vec![s]).unwrap_or_default(),
        SamplingStrategy::Random => {
            let count = (limit.max(0) as usize).min(samples.len());
            if count == 0 || samples.is_empty() {
                return Vec::new();
            }
            let mut rng = rand::rng();
            let mut indices: Vec<usize> = (0..samples.len()).collect();
            indices.shuffle(&mut rng);
            indices.into_iter().take(count).map(|i| samples[i].clone()).collect()
        }
        SamplingStrategy::Exhaustive => {
            let reps = if limit > 1 { limit as usize } else { 1 };
            let mut out = Vec::with_capacity(samples.len() * reps);
            for s in samples {
                for _ in 0..reps {
                    out.push(s.clone());
                }
            }
            out
        }
    }
}

pub fn parse_content_field(row: serde_json::Value) -> serde_json::Value {
    let Some(content) = row.get("content").and_then(serde_json::Value::as_str) else {
        return row;
    };
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(value) if value.is_object() || value.is_array() => value,
        _ => row,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_strategy_single_returns_first_only() {
        let samples = vec![
            serde_json::json!({"i": 0}),
            serde_json::json!({"i": 1}),
            serde_json::json!({"i": 2}),
        ];
        let out = apply_strategy(samples, &SamplingStrategy::Single, 99);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["i"], 0);
    }

    #[test]
    fn apply_strategy_single_on_empty_returns_empty() {
        let out = apply_strategy(vec![], &SamplingStrategy::Single, 5);
        assert!(out.is_empty());
    }

    #[test]
    fn apply_strategy_exhaustive_runs_every_row_once_by_default() {
        let samples = vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)];
        let out = apply_strategy(samples, &SamplingStrategy::Exhaustive, 1);
        assert_eq!(out, vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)]);
    }

    #[test]
    fn apply_strategy_exhaustive_repeats_each_row_when_limit_gt_one() {
        let samples = vec![serde_json::json!("a"), serde_json::json!("b")];
        let out = apply_strategy(samples, &SamplingStrategy::Exhaustive, 3);
        assert_eq!(
            out,
            vec![
                serde_json::json!("a"),
                serde_json::json!("a"),
                serde_json::json!("a"),
                serde_json::json!("b"),
                serde_json::json!("b"),
                serde_json::json!("b"),
            ]
        );
    }

    #[test]
    fn apply_strategy_exhaustive_zero_limit_treated_as_one() {
        let samples = vec![serde_json::json!(1), serde_json::json!(2)];
        let out = apply_strategy(samples, &SamplingStrategy::Exhaustive, 0);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn apply_strategy_random_returns_count_without_replacement() {
        let samples: Vec<_> = (0..10).map(serde_json::Value::from).collect();
        let out = apply_strategy(samples, &SamplingStrategy::Random, 4);
        assert_eq!(out.len(), 4);
        let mut seen: Vec<i64> = out.iter().map(|v| v.as_i64().unwrap()).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn parse_content_field_unwraps_json_object_string() {
        let row = serde_json::json!({
            "content": r#"{"word_de": "gehen", "word_en": "to go"}"#,
            "model": "bonsai-8b",
            "sample_index": 0,
        });
        let parsed = parse_content_field(row);
        assert_eq!(parsed["word_de"], "gehen");
        assert_eq!(parsed["word_en"], "to go");
        assert!(parsed.get("model").is_none());
        assert!(parsed.get("sample_index").is_none());
    }

    #[test]
    fn parse_content_field_unwraps_json_array_string() {
        let row = serde_json::json!({"content": "[1, 2, 3]"});
        let parsed = parse_content_field(row);
        assert_eq!(parsed, serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn parse_content_field_leaves_non_json_strings_alone() {
        let row = serde_json::json!({"content": "just plain prose, not JSON"});
        let parsed = parse_content_field(row.clone());
        assert_eq!(parsed, row);
    }

    #[test]
    fn parse_content_field_leaves_scalar_json_alone() {
        let row = serde_json::json!({"content": "42"});
        let parsed = parse_content_field(row.clone());
        assert_eq!(parsed["content"], "42");
    }

    #[test]
    fn parse_content_field_passthrough_when_no_content() {
        let row = serde_json::json!({"foo": "bar"});
        let parsed = parse_content_field(row.clone());
        assert_eq!(parsed, row);
    }
}
