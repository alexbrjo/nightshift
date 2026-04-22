# nightshift

A desktop-first experimentation platform for evaluating LLM-generated context. Open any directory as a project and work directly with files including Jinja prompt templates, JSON schemas, CSV/JSON/JSONL data, JavaScript scripts, and YAML pipeline definitions.

## Getting Started

Nightshift treats your filesystem as the source of truth. Drop a folder into the app and it becomes a project, with a per-project SQLite store handling experiment-generated data and all editor content and pipeline definitions living as files. The built-in code editor provides syntax highlighting and validation for Jinja2, JSON, JavaScript, CSV, and YAML, with undo/redo and auto-save across all panels.

## Bulk Inference

Configure jobs by pairing a Jinja template with optional input files to populate variables. Choose from single, random, or exhaustive sampling strategies, and pre-render URLs for RAG or external API integration. Select any OpenAI-compatible provider and configure temperature, token limits, and thinking budget. Output can be unstructured, plain JSON, or validated against a JSON Schema. Jobs run asynchronously in the background with real-time streaming, rate limit handling, and error recovery. Each sample produces rendered prompts, raw responses, parsed content, and token usage and latency metrics, with visual indicators for streaming, completed, and errored states.

## Bulk JavaScript Actions

Apply sandboxed JavaScript functions to datasets in the same job model as bulk inference, returning structured JSON results. This lets you reshape, statically eval, or enrich data without leaving the platform.

## Collections

Bulk inference output is organized into collections, which are batch-backed tables with automatic column detection from JSON Schema. Navigate large datasets with pagination at 50 items per page. Filter by search, delete individual items, and export to JSONL or CSV. Apply JavaScript bulk actions to reshape data before exporting.

## Experiment Pipelines

Chain jobs together in a visual workflow editor where the output of one stage feeds the input of the next. JSON schema definitions track the contracts between stages, and the final pipeline is saved as a YAML definition. Before committing to a full run, trial runs execute a small batch per experimental group to validate prompts, scripts, and evaluation configurations. During execution, a live view shows each stage's progress, aggregate metrics, and streamed results on a single page.

## Analysis Agents

Post-experiment evaluation agents walk through a structured workflow: running analysis queries, supplementing quantitative metrics with anecdotes, writing a summary, and proof-reading their work. Each agent runs in a sandboxed environment with a database scoped to only the current experiment. A copy-on-create model clones relevant tables (schemas, input data, intermediate results) into a per-run database. The agent reads and writes freely inside that boundary but cannot see or access data from other runs, ensuring complete isolation. Results are written to a single `analysis.md` file. Before cleanup, agents can export their findings for cross-run or suite-level meta-analysis.
