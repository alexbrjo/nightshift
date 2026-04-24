# Developer Guide

## Architecture Overview

Nightshift is an Electron-based desktop application with a React renderer and Node.js main process. The architecture follows a clear separation of concerns:

```
┌─────────────────────────────────────────────────────┐
│                    Renderer (React)                  │
│  ┌──────────┬──────────┬──────────┬──────────────┐  │
│  │ Editor   │ Inference│ Collections│ Pipelines   │  │
│  │ Panel    │ Panel    │ Manager   │ & Agents     │  │
│  └──────────┴──────────┴──────────┴──────────────┘  │
├─────────────────────────────────────────────────────┤
│              IPC Bridge (contextBridge)              │
├─────────────────────────────────────────────────────┤
│                    Main Process                      │
│  ┌──────────┬──────────┬──────────┬──────────────┐  │
│  │ File     │ DB       │ Inference│ Collections   │  │
│  │ Service  │ Layer    │ Engine   │ Manager      │  │
│  └──────────┴──────────┴──────────┴──────────────┘  │
│  ┌──────────┬──────────┬──────────┬──────────────┐  │
│  │ Bulk     │ Pipeline │ Analysis │ IPC Handlers │  │
│  │ Actions  │ Orch.    │ Agents   │              │  │
│  └──────────┴──────────┴──────────┴──────────────┘  │
├─────────────────────────────────────────────────────┤
│              SQLite (per-project)                    │
├─────────────────────────────────────────────────────┤
│              Project Files                           │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Security-first**: All LLM API calls run in the main process only. No external scripts loaded at runtime. Secrets never persisted to disk.
- **Sandboxed execution**: JavaScript bulk actions and analysis agents run in `vm2` sandboxes with restricted access.
- **Per-project SQLite**: Each project gets its own SQLite database (`nightshift.db`) for experiment data, job configurations, and pipeline definitions.
- **Copy-on-create isolation**: Analysis agent runs get their own cloned database snapshot, preventing cross-run data leakage.

## Project Layout

```
nightshift/
├── electron/                    # Electron main process code
│   ├── main.ts                  # Entry point - creates BrowserWindow
│   ├── preload.ts               # Context bridge API exposure
│   ├── main/
│   │   ├── db/
│   │   │   └── database.ts      # SQLite schema + CRUD operations
│   │   ├── filesystem/
│   │   │   └── fileService.ts   # File read/write/list with path validation
│   │   ├── inference/
│   │   │   ├── engine.ts        # Bulk LLM inference engine
│   │   │   ├── bulkActionExecutor.ts  # Sandboxed JS execution
│   │   │   └── pipelineOrchestrator.ts # Pipeline stage orchestration
│   │   ├── agents/
│   │   │   └── analysisAgent.ts # Analysis agent with isolated DB
│   │   └── ipcHandlers.ts       # All IPC handler registrations
├── src/
│   ├── shared/                  # Shared types and utilities
│   │   ├── types.ts             # TypeScript interfaces for all data models
│   │   ├── constants.ts         # App-wide constants (timeouts, limits)
│   │   ├── utils.ts             # Helper functions (pagination, YAML I/O)
│   │   └── test-setup.ts        # Vitest setup file
│   └── renderer/                # React renderer code
│       ├── App.tsx              # Main app shell with navigation
│       ├── styles.css           # Global styles (dark theme)
│       ├── components/
│       │   ├── FileTree.tsx     # Recursive directory tree component
│       │   └── CodeEditor.tsx   # Monaco Editor with tabs + auto-save
│       ├── pages/
│       │   ├── BulkInference.tsx    # Job creation + results view
│       │   ├── CollectionsManager.tsx # Table view + search + export
│       │   └── Pipelines.tsx        # Pipeline builder + runner
├── tests/
│   └── unit/                    # Unit tests (Vitest)
│       ├── utils.test.ts        # Shared utility function tests
│       ├── filesystem.test.ts   # File service tests
│       ├── database.test.ts     # SQLite CRUD operation tests
│       └── inference.test.ts    # Template rendering + sampling tests
├── index.html                   # HTML entry point
├── vite.config.ts               # Vite + Electron plugin config
├── vitest.config.ts             # Vitest test configuration
├── tsconfig.json                # TypeScript configuration
└── package.json                 # Dependencies and scripts
```

## Data Model

### Core Tables

#### `projects`
Stores project metadata. One row per opened folder.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID v4 |
| path | TEXT UNIQUE | Absolute filesystem path |
| name | TEXT | Folder name |
| settings | TEXT | JSON-encoded project settings |
| created_at | INTEGER | Unix timestamp |
| updated_at | INTEGER | Unix timestamp |

#### `inference_jobs`
Stores bulk inference job configurations.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID v4 |
| project_id | TEXT FK | References projects(id) |
| name | TEXT | Job display name |
| sampling_strategy | TEXT | 'single', 'random', or 'exhaustive' |
| num_samples | INTEGER | Number of samples for single/random |
| template_file | TEXT | Path to Jinja2 template |
| source_data_type | TEXT | 'file' or 'collection' |
| api_endpoint | TEXT | OpenAI-compatible API URL |
| model_name | TEXT | Model identifier |
| output_mode | TEXT | 'unstructured', 'plain-json', 'schema-validated' |
| temperature | REAL | 0.0 - 2.0 |
| max_tokens | INTEGER | Max response tokens |
| status | TEXT | 'pending', 'running', 'completed', 'errored' |
| total_samples | INTEGER | Total samples to process |
| completed_samples | INTEGER | Successfully processed count |
| errored_samples | INTEGER | Failed processing count |

#### `job_sample_results`
Stores individual sample results from inference jobs.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID v4 |
| job_id | TEXT FK | References inference_jobs(id) |
| sample_index | INTEGER | Zero-based index of the sample |
| status | TEXT | 'pending', 'completed', 'errored' |
| rendered_prompt | TEXT | Jinja2-rendered prompt text |
| raw_response | TEXT | Raw LLM API response |
| parsed_content | TEXT | JSON-parsed output (if applicable) |
| error | TEXT | Error message if failed |
| token_usage_prompt | INTEGER | Prompt tokens used |
| token_usage_completion | INTEGER | Completion tokens used |
| latency_ms | INTEGER | Response time in milliseconds |

#### Dynamic Collection Tables
Collections are stored as `items_{sanitized_name}` tables with auto-detected schemas tracked in `collections_meta`. Each item stores its data as JSON text.

```sql
CREATE TABLE items_collection_name (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,    -- JSON-encoded item
  created_at INTEGER NOT NULL
);
```

#### `bulk_actions`
Stores JavaScript bulk action configurations.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID v4 |
| project_id | TEXT FK | References projects(id) |
| name | TEXT | Action display name |
| source_collection | TEXT | Source collection name |
| target_collection | TEXT | Output collection name |
| script_file | TEXT | Path to JS script file |

#### `pipelines` / `pipeline_stages`
Pipeline definitions with ordered stages.

| Column | Type | Description |
|--------|------|-------------|
| pipelines.id | TEXT PK | Pipeline UUID |
| pipelines.name | TEXT | Pipeline name |
| pipeline_stages.pipeline_id | TEXT FK | References pipelines(id) |
| pipeline_stages.stage_type | TEXT | 'inference', 'javascript-action', 'analysis-agent' |
| pipeline_stages.order_num | INTEGER | Execution order |
| pipeline_stages.job_id | TEXT FK | Referenced inference job (for inference stages) |

#### `analysis_agent_configs` / `agent_runs`
Agent configurations and their execution history.

## Running Locally

### Setup

```bash
# Install dependencies
npm install

# Run in development mode with hot-reload
npm run dev

# Build for production
npm run build
```

### Testing

```bash
# Run all unit tests
npm test

# Watch mode for TDD
npm run test:watch

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix    # Auto-fix issues
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NIGHTSHIFT_API_KEY` | OpenAI-compatible API key | (empty) |

**Security**: API keys are never written to project files. They should be set via environment variables or a secure secrets manager.

### Project Structure for Experiments

A typical Nightshift project might look like:

```
my-experiment/
├── prompts/
│   ├── system.jinja2        # System prompt template
│   └── user.jinja2          # User prompt template
├── data/
│   ├── input.jsonl          # Input samples (JSONL format)
│   └── schema.json          # JSON Schema for output validation
├── scripts/
│   └── enrich.js            # Bulk action transformation script
├── pipelines/
│   └── evaluation.yaml      # Pipeline definition (exported)
└── nightshift.db            # Auto-created SQLite database
```
