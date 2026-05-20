use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const ITEM_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_TRANSFORM_INPUT_BYTES: usize = 1_000_000;
const MAX_TRANSFORM_STDOUT_BYTES: usize = 1_000_000;
const MAX_TRANSFORM_STDERR_BYTES: usize = 64_000;

const NODE_RUNNER: &str = r#"
const fs = require('node:fs');
const vm = require('node:vm');

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const wrappedScript = `(function(item) {\n"use strict";\n${input.script}\n})(__item)`;
  const context = vm.createContext({ __item: input.item });
  const result = vm.runInContext(wrappedScript, context, { timeout: 1000 });
  if (result === undefined) {
    throw new Error('Transform fragment returned undefined; return null to skip an item');
  }
  if (result === null) {
    process.stdout.write(JSON.stringify({ ok: true, skipped: true }));
  } else {
    process.stdout.write(JSON.stringify({ ok: true, value: result }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error && error.message ? error.message : String(error)
  }));
  process.exitCode = 1;
}
"#;

pub async fn check_transform_runtime() -> Result<(), String> {
    let output = Command::new("node")
        .arg("--version")
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("JavaScript transform runtime is unavailable: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err("JavaScript transform runtime is unavailable".to_string())
    }
}

pub async fn run_transform_script(script: &str, item: &Value) -> Result<Option<Value>, String> {
    let input = serde_json::json!({ "script": script, "item": item });
    let payload = serde_json::to_vec(&input)
        .map_err(|e| format!("Failed to serialize transform input: {}", e))?;
    if payload.len() > MAX_TRANSFORM_INPUT_BYTES {
        return Err("Transform input is too large".into());
    }
    let mut child = Command::new("node")
        .arg("-e")
        .arg(NODE_RUNNER)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start JavaScript transform runtime: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&payload)
            .await
            .map_err(|e| format!("Failed to send transform input: {}", e))?;
    }

    let output = match timeout(ITEM_TIMEOUT, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("Failed to run transform script: {}", e))?,
        Err(_) => return Err("Transform script timed out".to_string()),
    };

    if output.stdout.len() > MAX_TRANSFORM_STDOUT_BYTES {
        return Err("Transform script output exceeded size limit".into());
    }
    if output.stderr.len() > MAX_TRANSFORM_STDERR_BYTES {
        return Err("Transform script stderr exceeded size limit".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let response: Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Transform runtime returned invalid output: {}", e))?;
    if response.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let error =
            response.get("error").and_then(|v| v.as_str()).unwrap_or("Transform script failed");
        return Err(if stderr.trim().is_empty() {
            error.to_string()
        } else {
            format!("{}: {}", error, stderr.trim())
        });
    }
    if response.get("skipped").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(None);
    }
    response
        .get("value")
        .cloned()
        .map(Some)
        .ok_or("Transform runtime did not return a value".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn runtime_available() -> bool {
        check_transform_runtime().await.is_ok()
    }

    #[tokio::test]
    async fn run_transform_script_returns_value_and_skips_null() {
        if !runtime_available().await {
            return;
        }

        let output = run_transform_script(
            "return { value: item.value * 2 };",
            &serde_json::json!({ "value": 21 }),
        )
        .await
        .unwrap();
        assert_eq!(output, Some(serde_json::json!({ "value": 42 })));

        let skipped = run_transform_script("return null;", &serde_json::json!({ "value": 21 }))
            .await
            .unwrap();
        assert_eq!(skipped, None);
    }

    #[tokio::test]
    async fn run_transform_script_rejects_undefined() {
        if !runtime_available().await {
            return;
        }

        let err = run_transform_script("item.value;", &serde_json::json!({ "value": 21 }))
            .await
            .unwrap_err();
        assert!(err.contains("returned undefined"), "got: {err}");
    }

    #[tokio::test]
    async fn run_transform_script_does_not_expose_process() {
        if !runtime_available().await {
            return;
        }

        let output =
            run_transform_script("return { processType: typeof process };", &serde_json::json!({}))
                .await
                .unwrap();

        assert_eq!(output, Some(serde_json::json!({ "processType": "undefined" })));
    }

    #[tokio::test]
    async fn run_transform_script_rejects_oversized_input() {
        if !runtime_available().await {
            return;
        }

        let err = run_transform_script(
            "return item;",
            &serde_json::json!({ "value": "x".repeat(MAX_TRANSFORM_INPUT_BYTES) }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("input is too large"), "got: {err}");
    }

    #[tokio::test]
    async fn run_transform_script_rejects_oversized_output() {
        if !runtime_available().await {
            return;
        }

        let err = run_transform_script(
            &format!("return {{ value: 'x'.repeat({}) }};", MAX_TRANSFORM_STDOUT_BYTES + 1),
            &serde_json::json!({}),
        )
        .await
        .unwrap_err();

        assert!(err.contains("output exceeded size limit"), "got: {err}");
    }
}
