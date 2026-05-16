#[cfg(test)]
mod tests {
    use super::super::*;

    #[test]
    fn parses_function_calls_from_responses_output() {
        let response = json!({
            "id": "resp_1",
            "output": [{
                "type": "function_call",
                "call_id": "call_1",
                "name": "create_new_method",
                "arguments": "{\"title\":\"T\",\"objective\":\"O\"}"
            }]
        });

        let calls = response_function_calls(&response).unwrap();

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "create_new_method");
    }

    #[test]
    fn extracts_message_text_from_responses_output() {
        let response = json!({
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": "Draft created." }]
            }]
        });

        assert_eq!(response_text(&response).unwrap(), "Draft created.");
    }

    #[test]
    fn extracts_reasoning_summaries_from_responses_output() {
        let response = json!({
            "output": [{
                "type": "reasoning",
                "summary": [{ "type": "summary_text", "text": "Checked resources and graph blockers." }]
            }]
        });

        assert_eq!(
            response_reasoning_summaries(&response),
            vec!["Checked resources and graph blockers.".to_string()]
        );
    }

    #[test]
    fn reasoning_summary_config_is_limited_to_reasoning_models() {
        assert_eq!(method_agent_reasoning_config("gpt-5.5"), Some(json!({ "summary": "auto" })));
        assert_eq!(method_agent_reasoning_config("o4-mini"), Some(json!({ "summary": "auto" })));
        assert_eq!(method_agent_reasoning_config("gpt-4o"), None);
    }

    #[test]
    fn method_agent_instructions_ask_for_portable_gfm() {
        let instructions = method_agent_instructions();

        assert!(instructions.contains("Use portable GitHub Flavored Markdown for readability"));
        assert!(instructions.contains("fenced code blocks only for code, paths, or configuration"));
        assert!(instructions.contains("Do not use raw HTML"));
        assert!(instructions.contains("filesystem tools"));
        assert!(instructions.contains("Use node config only for settings that must differ by node"));
        assert!(instructions.contains("Prompt-based judging is an inference node"));
    }

    #[test]
    fn summarizes_and_sanitizes_tool_trace_details() {
        let output = json!({
            "ok": true,
            "result": {
                "draft": {
                    "title": "Edge method",
                    "workflow": { "nodes": [
                        { "id": "prompt", "type": "resource" },
                        { "id": "generate", "type": "inference" },
                        { "id": "judge", "type": "transform" }
                    ] }
                }
            }
        });
        let arguments = json!({
            "api_key": "secret-value",
            "max_tokens": 2000,
            "reference": "sk-example1234567890example1234567890",
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "oauth": "ya29.a0AfH6SMB1234567890abcdef/abcdefghi=",
            "path": "flash_cards/conjugations_prompt.jinja2",
            "long": "x".repeat(900)
        });

        assert_eq!(
            summarize_tool_output("replace_method_draft_graph", &output).unwrap(),
            "Draft 'Edge method' - 3 nodes - 1 resource"
        );
        let sanitized = sanitize_tool_value(&arguments);
        assert_eq!(sanitized["api_key"], "[redacted]");
        assert_eq!(sanitized["max_tokens"], 2000);
        assert_eq!(sanitized["reference"], "[redacted]");
        assert_eq!(sanitized["commit"], "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(sanitized["oauth"], "[redacted]");
        assert_eq!(sanitized["path"], "flash_cards/conjugations_prompt.jinja2");
        assert!(sanitized["long"].as_str().unwrap().ends_with("..."));
    }

    #[test]
    fn tool_errors_are_returned_as_repairable_outputs() {
        let output = tool_error_output(
            "replace_method_draft_graph",
            "draft edge starts at unknown node 'sample_verbs'",
            "Revise the tool arguments and call the tool again.",
        );

        assert_eq!(output["ok"], false);
        assert!(output["error"].as_str().unwrap().contains("sample_verbs"));
        assert!(output["instruction"].as_str().unwrap().contains("call the tool again"));
    }
}
