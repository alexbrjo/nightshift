# Nightshift

A desktop-first experimentation platform for evaluating LLM-generated context. Open any directory as a project and work directly with files including Jinja prompt templates, JSON schemas, CSV/JSON/JSONL data, JavaScript scripts, and YAML pipeline definitions.

## Current Status: In Progress (~75-80% complete)

This is an active implementation. Core features are functional but some高级 features are still being built.

---

## Running

```bash
npm install
npx electron-builder install-app-deps   # rebuilds native modules for Electron
npm run dev                             # development mode with hot reload
```

Production build:

```bash
npm run build    # typecheck → vite build → electron-builder
```

---

## Architecture

```
nightshift/
├── electron/
│   ├── main.ts          # Main process: window management, IPC handlers
│   ├── preload.ts       # Context bridge (file ops, dialogs, database)
│   └── database.ts      # SQLite via better-sqlite3 (collections CRUD)
└── src/
    ├── App.tsx           # Root: project loading, tab/view management
    ├── components/
    │   ├── EditorPanel.tsx     # Monaco editor + run job/pipeline buttons
    │   ├── FileTree.tsx        # Sidebar file browser
    │   ├── CollectionsView.tsx # Collection list view
    │   ├── JobsView.tsx        # Job list view
    │   ├── PipelinesView.tsx   # Pipeline list view
    │   └── PipelineEditor.tsx  # Visual pipeline workflow editor (not wired)
    └── services/
        ├── inference.ts  # Bulk LLM inference engine
        ├── pipeline.ts   # Sequential pipeline stage executor
        └── agents.ts     # Analysis agent system (stub, not integrated)
```

### Data Model

Projects are directories on disk. A per-project SQLite store (`nightshift.db`) tracks:

- **collections** / **collection_items** — inference results and their rows
- **jobs** — job configurations and status (file-based; metadata table exists but unused)
- **pipelines** — pipeline definitions and stage configs (file-based; metadata table exists but unused)
- **experiments** — experiment runs (table exists, not used)

### File Types

| Extension | Description |
|-----------|-------------|
| `.collection.json` | Collection of inference results |
| `.job.json` | Job configuration (template path, sampling strategy, API key, etc.) |
| `.pipeline.yaml` | Pipeline definition with sequential stages |
| `.txt` / `.md` | Plain text or markdown files |

---

## Implemented Features

### File Browser & Editor
- Open any directory as a project — file tree on the left, tabs on top
- Monaco editor with syntax highlighting for JSON, YAML, JavaScript, Jinja2 (via Monarch tokenizer), and CSV
- Auto-save indicator shows when content has changed
- Tab management: open multiple files, close tabs

### Collections View
- Lists all `.collection.json` files in the project
- Click to open a collection in the editor
- `+ New` button creates a new empty collection file

### Jobs View & Execution
- Lists all `.job.json` files with status badges (pending / running / completed)
- `+ New` creates a properly structured job config file
- **Run Job** button appears in EditorPanel when a job file is open:
  - Parses the job config (template path, sampling strategy, input data paths)
  - Renders Jinja2 template with each input row
  - Makes API calls to an OpenAI-compatible endpoint
  - Updates a live progress bar (`current/total`)
  - Saves results as a `.collection.json` file on completion

### Pipeline Execution Engine (`src/services/pipeline.ts`)
- Executes stages sequentially: **inference → js-action → evaluation**
- Each stage's output becomes the next stage's input data
- Progress callbacks wired to UI for real-time status updates
- Stage types:
  - `inference` — calls LLM with template + context variables
  - `js-action` — runs a sandboxed JS function over the data
  - `evaluation` — scoring/grading pass

### Live Progress Bar
- Appears below the toolbar during job or pipeline runs
- Shows `{status} (current/total)` with an animated green fill bar

---

## Not Yet Implemented

| Feature | Notes |
|---------|-------|
| **PipelineEditor visual component** | Exists at `src/components/PipelineEditor.tsx` but is never rendered. Clicking a pipeline opens raw YAML in Monaco instead of the visual editor. |
| **Analysis Agents** | `src/services/agents.ts` has stub methods but no UI integration to trigger them. No `analysis.md` output. |
| **Jobs / Pipelines → SQLite** | Tables exist in `electron/database.ts` but jobs and pipelines are saved only as files, not written to the database. |
| **Trial run mode for pipelines** | Single-item pass-through validation before a full pipeline run is not yet built. |
| **Export to CSV/JSONL** | Collections view has no export buttons. |
| **YAML parsing** | Pipeline executor uses regex-based line parsing instead of the already-installed `js-yaml` package. |

---

## Design Decisions

- **File-based project + SQLite overlay** — Project folders are portable and self-contained (all source files on disk). A per-project SQLite store holds experiment-generated data and metadata that doesn't belong in source files.
- **Template-driven inference** — Job configs reference a template file plus input data files by path. This avoids duplicating prompts across many inputs.
- **Sequential pipeline stages** — Each stage's output becomes the next stage's input, making it easy to chain: generate → transform with JS → evaluate.

---

## Framework Stack

| Layer | Choice |
|-------|--------|
| Desktop shell | Electron 33 + Vite 6 (via `vite-plugin-electron`) |
| UI | React 18 + Zustand (lightweight global state) |
| Editor | Monaco Editor (`@monaco-editor/react`) with custom Jinja2 Monarch tokenizer |
| Database | SQLite via `better-sqlite3` (synchronous, main process only) |
| YAML parsing | `js-yaml` installed but pipeline executor uses regex instead |

### Native Module Note

`better-sqlite3` is a native module that must be rebuilt for Electron's Node version:

```bash
npx electron-builder install-app-deps
```

Vite config (`vite.config.ts`) marks it as external in the Rollup bundle since it's loaded by the main process, not the renderer.

---

## Build Verification

Production builds cleanly:

```bash
npx vite build   # ✓ built in ~272ms
```