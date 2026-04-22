# Nightshift

A desktop-first experimentation platform for evaluating LLM-generated context. Open any directory as a project and work directly with files including Jinja prompt templates, JSON schemas, CSV/JSON/JSONL data, JavaScript scripts, and YAML pipeline definitions.

## Features

### File System & Code Editor
- Drop a folder into the app and it becomes a project, with `.nightshift/` handling all internal data
- Built-in Monaco code editor with syntax highlighting for Jinja2, JSON, JavaScript, CSV, and YAML
- Multi-tab editing, undo/redo, auto-save tracking, and keyboard shortcuts (Ctrl+S to save)

### Bulk Inference
- Configure jobs by pairing a Jinja template with optional input files to populate variables
- Choose from single, random, or exhaustive sampling strategies
- Select any OpenAI-compatible provider; configure temperature, token limits, and thinking budget
- Output as unstructured text, plain JSON, or validated against a JSON Schema
- Background job execution with real-time progress tracking

### Bulk JavaScript Actions
- Apply sandboxed JavaScript functions to datasets in the same job model as bulk inference
- Returns structured JSON results for reshaping, static evaluation, or data enrichment

### Collections
- Batch-backed tables with automatic column detection from input data
- Pagination at 50 items per page; filter by search, delete individual items
- Export to JSONL or CSV

### Experiment Pipelines
- Chain jobs together in a visual workflow editor where the output of one stage feeds the next
- Stage types: Inference, JavaScript, Filter, Transform
- Pipeline definitions saved as YAML; trial runs execute a small batch per experimental group before full execution

### Analysis Agents
- Post-experiment evaluation agents walk through a structured workflow: queries → anecdotes → summary → review
- Each agent runs in an isolated environment with a copy-on-create model that clones relevant tables into a per-run database directory
- Results written to `analysis.md`; exportable for cross-run meta-analysis

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Desktop runtime | Tauri v2 (Rust) | Small binary, native OS APIs, Rust safety for sandboxed execution |
| Frontend framework | React 19 | Component model, ecosystem maturity, hooks-based state |
| Build tool | Vite | Fast HMR, built-in TypeScript support, simple config |
| Styling | Tailwind CSS v4 + custom theme tokens | Utility-first rapid UI development, dark-first design |
| State management | Zustand | Minimal API, no providers needed, works with React 19 concurrent features |
| Routing | React Router DOM v7 | Standard SPA routing |
| Code editor | Monaco Editor (@monaco-editor/react) | VS Code's editor engine — best-in-class for JS/JSON/YAML syntax highlighting |
| Icons | Lucide React | Clean, consistent icon set with good tree-shaking |

### Backend Dependencies
- **rusqlite** (bundled) — SQLite database without system dependencies
- **reqwest + tokio** — Async HTTP client for LLM API calls and streaming
- **walkdir + globset** — Filesystem traversal for project trees
- **yaml-rust2, csv** — Pipeline YAML serialization/deserialization and CSV export

## Architecture Decisions

- **Filesystem as source of truth** — Pipeline definitions, schemas, and editor content live as files on disk in the `.nightshift/` directory, not just in SQLite. This matches the spec that Nightshift treats your filesystem as the ground truth.
- **Copy-on-create for agent isolation** — Analysis agents get their own subdirectory with cloned tables, so they can't leak data between runs. Implemented at the filesystem level; DB-level isolation is pending.
- **Zustand over Redux/Context** — Chosen for simplicity and zero boilerplate. The store has all state in one place with no provider nesting needed.
- **Monaco Editor over CodeMirror** — Monaco gives better TypeScript/Jinja2 support out of the box, which matters for a code editor targeting those languages specifically.
- **Tauri 2 over Electron** — Much smaller bundle size (~5MB vs ~150MB), native OS integration, and Rust backend lets us do filesystem operations and sandboxed execution without Node security concerns.

## Getting Started

### Prerequisites
- Node.js 18+ and npm
- Rust toolchain (`rustup` — install from https://rustup.rs)
- On macOS: `xcode-select --install` for the clang compiler

### Install dependencies
```bash
npm install
```

### Development mode (frontend + desktop app)
```bash
npm run tauri dev
```
This starts the Vite dev server on port 1420 and launches the Tauri window pointing at it.

### Build for production
```bash
# Frontend only (web build)
npm run build          # outputs to dist/

# Full desktop app
npm run tauri build    # builds frontend + compiles Rust, produces signed .dmg/.app on macOS
```

## Project Structure

```
nightshift/
├── src-tauri/                  # Rust backend
│   ├── Cargo.toml              # Dependencies: rusqlite, reqwest, tokio, etc.
│   ├── tauri.conf.json         # App config (identifier, window size, dist path)
│   └── src/
│       ├── main.rs             # Entry point — calls run()
│       └── lib.rs              # All Tauri commands: file ops, LLM calls, exports
├── src/                        # React frontend
│   ├── types/                  # Shared TypeScript interfaces (Project, JobConfig, etc.)
│   ├── lib/
│   │   └── store.ts            # Zustand store — all app state and actions
│   ├── components/
│   │   ├── Sidebar.tsx         # Navigation sidebar with view switching
│   │   ├── FileExplorer.tsx    # Recursive file tree with lazy directory loading
│   │   ├── CodeEditor.tsx      # Monaco editor wrapper with tabs, undo/redo, save
│   │   ├── BulkInference.tsx   # Job config UI: template, inputs, provider settings
│   │   ├── BulkJavaScript.tsx  # JS action UI with script preview and execution
│   │   ├── CollectionsView.tsx # Table viewer: pagination, search, selection, export
│   │   ├── PipelineEditor.tsx  # Visual workflow editor with stage nodes + SVG connections
│   │   └── AnalysisAgents.tsx  # Step-by-step agent workflow UI with results panel
│   ├── App.tsx                 # Main layout — sidebar + content area routing
│   ├── router.tsx              # React Router setup
│   ├── index.css               # Tailwind v4 theme tokens (dark colors, scrollbar styles)
│   └── main.tsx                # Entry point
├── package.json                # Scripts: dev, build, tauri dev/build
├── vite.config.ts              # Vite + React plugin + Tailwind CSS v4 plugin
├── tsconfig.app.json           # TypeScript config with @/ path alias
└── progress.txt                # Implementation status and TODOs
```

## Tauri Commands (Rust Backend)

| Command | Purpose |
|---------|---------|
| `list_directory(path)` | Recursively list files in a directory |
| `read_file(path)` | Read file contents as string |
| `write_file(path, content)` | Write string to file, creating parent dirs if needed |
| `delete_file(path)` | Delete a file or remove a directory tree |
| `create_directory(path)` | Create a directory (and parents) |
| `get_project_tree(root_path, max_depth)` | Walk the project tree up to N levels deep |
| `open_project(path)` | Open a folder as a project, create `.nightshift/` dir |
| `create_job(project_id, name, type, config)` | Create a new inference or JS action job |
| `call_llm(url, model, messages, ...)` | Call any OpenAI-compatible API endpoint |
| `execute_js(script, input_data)` | Execute JavaScript in sandboxed runtime (placeholder) |
| `save_pipeline_yaml(path, content)` | Save pipeline definition as YAML file |
| `load_pipeline_yaml(path)` | Load and return a YAML pipeline definition |
| `export_to_jsonl(items, path)` | Export items to JSONL format |
| `export_to_csv(items, path)` | Export items to CSV with auto-detected headers |
| `create_agent_db(project_path, run_id)` | Create isolated directory for an analysis agent's data |
| `save_analysis_result(path, content)` | Save agent findings to a file |
| `get_app_data_dir()` | Get the platform-specific app data directory |
| `file_exists(path)` | Check if a path exists on disk |

## Implementation Status

### Completed ✅
- Full UI shell with sidebar navigation and dark theme
- File explorer with recursive tree loading via Tauri commands
- Monaco code editor with syntax highlighting, multi-tab editing, undo/redo
- Bulk Inference configuration UI (template, inputs, sampling, provider settings)
- Bulk JavaScript Actions UI with script preview
- Collections table viewer: pagination (50/page), search, selection, delete, JSONL/CSV export
- Pipeline visual editor: stage nodes, SVG connections, add/remove stages, YAML I/O
- Analysis Agents workflow UI: step progress, metrics panel, results display

### Pending / Needs Real Implementation 🔲
| Area | Status | What's needed |
|------|--------|---------------|
| File save in CodeEditor | Mocked (logs to console) | Wire `handleSave` to call `invoke('write_file', ...)` and clear unsaved indicator |
| Project open/close flow | Partially wired | Add file picker dialog, project registry, `.nightshift/` management |
| SQLite persistence | rusqlite in Cargo.toml but no schema/migrations | Database initialization, per-project stores for experiments/collections/jobs |
| Bulk Inference API calls | `call_llm` command exists but returns static response | Real streaming HTTP client with rate limiting, error recovery, token tracking |
| JavaScript Actions execution | `execute_js` returns an error placeholder | Sandboxed JS runtime (quickjs-rs or wasm-based) — the hardest piece |
| Job orchestration | Progress bar increments with `setTimeout` | Async job runner with background workers and real-time progress events to frontend |
| Pipeline execution | Buttons trigger mock runs | Actual stage chaining: output of one stage feeds input of next, YAML serialization/deserialization |
| Analysis Agents workflow | Simulated workflow with delays | Real agent loop: run SQL queries → collect results → generate anecdotes → write summary → review |

See `progress.txt` for the full detailed TODO list.
