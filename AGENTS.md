# Nightshift Development Rules

## General Principles

1. Code MUST utilize appropriate design patterns for the task.
2. Code should be DRY. Extract constants and common logic to their own files.
3. Code MUST handle edge cases and errors.

## New code change checklist

- You MUST include tests that validate and protect new and affected code paths
  - Virtually all changes should have unit tests
  - Very often changes should include integration tests
  - For changes that affect the UX, include E2E/UI tests

## Anti-Patterns (MUST NOT)

- MUST NOT load scripts from external sources at runtime. All dependencies bundled.
- MUST NOT call LLM provider APIs from the renderer process. Inference runs in the main process.
- MUST NOT persist secretes (API keys, passwords, etc) to disk in plaintext or in any project file.
- MUST NOT leave mocked data in shipped components. Render a visible "Not implemented" state for unimplemented components.
- MUST NOT commit build artifacts or dependency folders.
