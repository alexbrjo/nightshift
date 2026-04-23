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
- You MUST document UX and functionality changes
  - For changes that affect UX, update the USER_GUIDE.md
  - For changes that affect the architecture or data models update the DEVELOPER_GUIDE.md
