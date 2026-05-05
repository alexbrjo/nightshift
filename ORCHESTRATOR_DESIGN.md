# Agentic Experiment Orchestrator + Executor

## Context

Nightshift today has a working **single-job inference executor**: `inference_jobs` rows configure a single bulk LLM job, `JobExecutor` runs it sequentially, results land in a flat `collections` / `collection_items` table. There is no concept of an experiment (multi-stage pipeline), no agentic orchestration, and no versioning of job configurations.

This plan introduces:

1. A polymorphic, nestable **definition model** (Paradigm B from prior design) that subsumes inference jobs, JS actions, analysis agents, and group composition under one tree.
2. **Database-native immutable versioning** of definitions — every save creates a content-addressed version row; executions pin to a specific version for full reproducibility. Definition state lives in the DB (YAML is for export/import only and is deferred to a later plan).
3. An **agentic orchestrator** that walks a definition tree, plans the execution, dispatches to per-kind workers, and maintains a Magentic-One-style ledger of progress. **P0 covers the happy path only**: planning happens once at run start; re-plan, stuck-detection, and supersedence are deferred to a later phase.
4. **Unification of the sandbox path** — single ad-hoc inference jobs become flat root definitions; the legacy `inference_jobs` table and commands are removed. One model, one path.

**The existing UI is the canonical shape — adapt, don't replace.** Nightshift already has a working set of components for job creation, listing, progress display, and collection viewing. They've been used and debugged. The orchestrator work **renames and adapts them in place** to operate on `job_definition` / `job_definition_version` / `job_execution` / `collection` rows instead of the legacy schema. The visual structure (sidebar + main, status badges, type chips, paginated tables), the error pipeline (`useToast`, field-error maps, structured form errors), the polling pattern (`useActiveRefresh`), the file-picker pattern with project-root relativization, and the column auto-detection in `CollectionViewer` all carry over. Component renames are mechanical; what changes is which Tauri commands they call and which types they bind to. Building a new UI from scratch was tried and rejected — the working shape is the design.

Functional focus only. The following are explicitly **out of scope** for this plan:
- Parallel / concurrent execution, throughput optimization, learned routing, AIMD concurrency, per-backend queues — the chassis is functional-first; performance comes later.
- Audit logging — `tracing::{info,warn,error}` macros remain for dev/debug; planner state and agent progress live as functional state on `job_execution` rows (`plan`, `ledger`), not as a separate audit log.
- YAML export/import of definitions — definition state is DB-native; YAML serialization is deferred.
- Polished form-builder editors per kind — v1 edits `params` and `input_ref` as JSON in CodeMirror.
- JS action runtime — `kind='js_action'` is reserved in the schema; the worker returns `WorkerError::NotImplemented` until a runtime is chosen.

## Scope summary

| In scope | Out of scope |
|---|---|
| New DB schema (6 tables) | Concurrency / parallelism in workers |
| Definition CRUD with DB-native immutable versioning | Audit logging, OTEL export, external observability |
| Orchestrator: planner, dispatcher, resolver, workers | YAML export/import of definitions (deferred) |
| InferenceWorker (refactor of existing `JobExecutor::execute_job` body) | Form-builder editors per kind |
| AnalysisWorker (LLM-driven analysis loop with bounded tool surface) | JS action runtime (kind reserved, worker stubbed) |
| Sandbox unified into flat root definitions; legacy path removed | Bandit routing, learned model selection |
| New Tauri command + event surface (legacy commands/events removed) | Multi-project / multi-window support |
| Frontend: adapt existing UI in place (rename + rewire `JobRunnerPage`/`InferenceJobForm`/`JobListSidebar`/`JobViewPage`); reuse `CollectionViewer`/`CollectionsList`/`Toast`/`useActiveRefresh` as-is; add `LedgerTimeline` + `DefinitionHistoryPanel` + `src/api/orchestrator.ts` | Polished UX, theming, animations, redesigned visuals |
| Tiny migration framework (schema_version table) + legacy data migration | Online schema evolution |

## End-state schema

All tables singular per agreed convention. FKs follow `<table>_id` for cross-table; `parent_id`, `root_id` reserved for self-references.

Six tables total: `job_definition`, `job_definition_version`, `job_execution`, `collection`, `collection_item`, `schema_version`. The legacy `inference_jobs` table is dropped as part of the unification migration.

### `job_definition` — logical identity (mutable)

```
id                  INTEGER PK
parent_id           INTEGER NULL → job_definition.id      -- NULL = root
root_id             INTEGER NOT NULL → job_definition.id  -- equals id for roots
name                TEXT NOT NULL
position            INTEGER NOT NULL                       -- ordering among siblings
current_version_id  INTEGER NULL → job_definition_version.id  -- HEAD; NULL until first save_version
source              TEXT NOT NULL                          -- 'user' | 'synthesized'
deleted_at          DATETIME NULL                          -- soft delete
created_at, updated_at  DATETIME

UNIQUE (parent_id, name) WHERE deleted_at IS NULL
UNIQUE (name) WHERE parent_id IS NULL AND deleted_at IS NULL  -- partial: root names
INDEX  (root_id), INDEX (parent_id)
```

Identity is mutable: `name`, `parent_id`, `position` can change (rename, move, reorder). Content is in versions. Soft-delete preserves historical executions' references.

### `job_definition_version` — immutable content snapshots (DB-native)

```
id                          INTEGER PK
definition_id               INTEGER NOT NULL → job_definition.id
parent_version_id           INTEGER NULL → job_definition_version.id  -- chain for diff/history
content_hash                TEXT NOT NULL                              -- SHA-256 of canonical JSON (dedup)
kind                        TEXT NOT NULL                              -- 'group'|'inference'|'js_action'|'analysis'
mode                        TEXT NULL                                  -- only for kind='group'
params                      JSON NOT NULL                              -- kind-specific config
input_ref                   JSON NULL                                  -- dataflow source
description                 TEXT NULL
message                     TEXT NULL                                  -- optional change message
created_by                  TEXT NOT NULL                              -- 'user' | 'planner:<root_exec_id>'
triggered_by_execution_id   INTEGER NULL → job_execution.id            -- non-null for planner-synthesized versions
created_at                  DATETIME

UNIQUE (definition_id, content_hash)   -- dedup: identical content → same row
INDEX  (definition_id, created_at)     -- history per definition
INDEX  (content_hash)
```

Versioning is DB-native: no filesystem, no git. `DefinitionService` canonicalizes the content tuple `{kind, mode, params, input_ref, description}` and computes `content_hash` over a stable serialization. Identical content collapses to one row. Only content edits create versions; renames, moves, and reorderings are pure identity mutations on `job_definition`.

**Why two tables instead of one append-only `job_definition_version`?** Considered: collapse identity into the version table (every "version" carries `name`, `parent_id`, `position`, the latest non-deleted row is HEAD). Tradeoffs:
- *Single table:* fewer joins, simpler write path. But every rename, move, or reorder produces a "version" that doesn't represent a content change — version history becomes polluted with non-content edits, and `definition_list_versions` becomes useless for "show me how this step's content has evolved."
- *Two tables (chosen):* identity (mutable) is cleanly separated from content (immutable). Renames are O(1) UPDATEs; content versions chronicle only what actually matters for reproducibility (kind/params/input_ref). FKs from `job_execution` pin to content, not identity, so renaming a definition mid-run is safe and intuitive. Cost: one extra join when reading "current state of definition X" — trivial.

The append-only property is preserved either way; the question is only what counts as a version-worthy change.

### `job_execution` — execution tree mirroring definition tree

```
id                       INTEGER PK
definition_version_id    INTEGER NOT NULL → job_definition_version.id  -- pinned content
parent_id                INTEGER NULL → job_execution.id                -- self-FK
root_id                  INTEGER NOT NULL → job_execution.id
status                   TEXT NOT NULL  -- 'pending'|'running'|'completed'|'failed'|'cancelled'
plan                     JSON NULL      -- root-only: planner's decomposition
ledger                   JSON NULL      -- progress entries; root holds task ledger; multi-step leaves hold their own
cancellation_requested   INTEGER NOT NULL DEFAULT 0   -- bool flag, polled by workers
started_at, finished_at  DATETIME NULL
error                    TEXT NULL
created_at               DATETIME

INDEX (root_id, status), INDEX (status, started_at)
INDEX (definition_version_id, started_at)
```

Per-row retries live on `collection_item.attempt`. The execution row itself has no retry counter in P0 — happy-path-first; re-execution / re-plan / supersedence is deferred to a later phase.

`ledger` lives on **any execution row that has multi-step state**: the root's ledger holds the planner's progress entries; an `AnalysisWorker` leaf holds its own ledger of agent steps (queries → anecdotes → draft → proofread). This is the functional state of the agentic loop.

### `collection` — output artifact, one per leaf execution

```
id              INTEGER PK
execution_id    INTEGER NOT NULL UNIQUE → job_execution.id
definition_id   INTEGER NOT NULL → job_definition.id          -- denorm convenience
name            TEXT NOT NULL
schema          JSON NULL                                       -- pinned at execution start from definition version
created_at      DATETIME

INDEX (definition_id, created_at)
```

### `collection_item` — output rows + per-row execution state

```
id              INTEGER PK
collection_id   INTEGER NOT NULL → collection.id
item_index      INTEGER NOT NULL                                -- renamed from `index` (SQL keyword)
status          TEXT NOT NULL  -- 'pending'|'running'|'completed'|'failed'|'skipped'
attempt         INTEGER NOT NULL DEFAULT 0
data            JSON NULL                                       -- NULL until completed
error           TEXT NULL
backend         TEXT NULL                                       -- 'openai:gpt-4o' etc.
input_tokens    INTEGER NULL
output_tokens   INTEGER NULL
cached_tokens   INTEGER NULL
latency_ms      INTEGER NULL
started_at, finished_at DATETIME NULL
created_at, updated_at  DATETIME

UNIQUE (collection_id, item_index)
INDEX  (collection_id, status)
```

Pending rows are inserted at execution start with `status='pending'` and `data=NULL`. Restart-resume scans `WHERE status IN ('pending','running')`.

### `schema_version` — minimal migration tracker

```
version         INTEGER PK
applied_at      DATETIME NOT NULL
description     TEXT NOT NULL
```

A `Vec<Migration>` in a new `migrations/` module is iterated on startup; each migration runs in a transaction if its version is not yet recorded.

**Why a tracker rather than relying on `CREATE TABLE IF NOT EXISTS`?** The existing approach works only for additive `CREATE TABLE` statements, which are naturally idempotent. The migrations needed here are not all idempotent: `m003_unify_legacy` reads `inference_jobs` rows, inserts derived rows into the new tables, then `DROP TABLE inference_jobs`. Running it twice would double-insert (first time) or fail (second time, because the legacy table is gone). A version tracker lets each migration encode the most natural SQL for its job and trust the runner to apply it exactly once. As soon as the schema needs anything beyond pure-additive — `ALTER`, `INSERT INTO … SELECT`, `DROP`, data backfill — a tracker is the simplest correct answer. The cost is one tiny table and ~30 lines of runner code.

## On-disk layout

```
<project>/
├── .git/                          ← user's own VCS (untouched)
└── .nightshift/
    └── nightshift.db              ← single SQLite store; all definition + execution state
```

No filesystem definition tree, no internal git repo. All definition state — identity, content, versions, executions, collections — lives in `nightshift.db`. YAML serialization for export/import is deferred to a later plan.

## Versioning lifecycle (DB-native)

1. **Create** a definition → `definition_create(parent_id?, name, kind, position)` inserts a `job_definition` row with `current_version_id = NULL`. Identity exists; content does not yet.
2. **Save** content → `definition_save_version(def_id, content)` where `content = {kind, mode, params, input_ref, description, message?}`. `DefinitionService` validates content against the kind's schema, canonicalizes the JSON, computes `content_hash`. If a version with that hash already exists for this definition, returns it (dedup); otherwise inserts a new `job_definition_version` row chained via `parent_version_id` to the previous HEAD. Updates `job_definition.current_version_id`.
3. **Run** an experiment → orchestrator walks the definition tree. Every definition referenced (root + descendants) must have `current_version_id IS NOT NULL`; otherwise `experiment_start` fails with a structured "unsaved definitions" error listing offending def_ids. `job_execution` rows reference `definition_version_id`, pinning each execution to immutable content for the run's lifetime.
4. **History**: `definition_list_versions(def_id)` returns versions in chronological order. The history panel shows each version's content; comparing two versions (structured diff) is deferred and is not part of P0.
5. **Replay** an old run → start a new execution against an existing `definition_version_id`. The orchestrator reads version content directly from the row; no checkout step.
6. **Edit during a live run** is safe by construction: the running execution holds an FK to its pinned `definition_version_id`. New saves create new version rows but do not affect in-flight executions. The UI shows a "version pinned" indicator on running nodes.
7. **Identity mutations** (rename, move, reorder, soft-delete) act on `job_definition` only. They do not produce versions and do not invalidate prior versions or executions.

`tracing::info!` covers the dev/debug trail for definition changes (who-when-what). Git is not used; SQLite is the single source of truth.

## Orchestrator components

All Rust, all in a new `src-tauri/src/orchestrator/` module. No new external dependencies (no `git2`).

### How they fit together

```
                   Tauri command (e.g. experiment_start)
                                  │
                                  ▼
               ┌──────────────────────────────────────┐
               │             Orchestrator             │
               │  - Tauri State singleton             │
               │  - owns the other components         │
               │  - public API: start_run, cancel_run │
               └──┬──────────┬──────────┬─────────────┘
                  │          │          │
       reads/writes  invokes once    polls runnable rows
                  │          │          │
                  ▼          ▼          ▼
        ┌──────────────┐ ┌────────┐ ┌────────────┐
        │  Definition  │ │Planner │ │ Dispatcher │
        │   Service    │ │        │ │            │
        │ (CRUD over   │ │ LLM →  │ │ picks next │
        │  job_def +   │ │  plan  │ │  pending   │
        │  job_def_    │ │ JSON,  │ │ execution  │
        │  version)    │ │ ledger │ │ row by     │
        └──────┬───────┘ │ seed   │ │ kind       │
               │         └────┬───┘ └─────┬──────┘
               │              │           │
               │              │           ▼ hands row to
               │              │   ┌──────────────────────────┐
               │              │   │       Worker (trait)     │
               │              │   ├──────────┬───────┬───────┤
               │              │   │Inference │Group  │Anal-  │
               │              │   │Worker    │Worker │ysis   │
               │              │   │          │       │Worker │
               │              │   └────┬─────┴───┬───┴───┬───┘
               │              │        │         │       │
               │              │        │ creates │       │
               │              │        │ children│       │
               │              │        ▼         │       │
               │              │  child job_execution rows│
               │              │                  │       │
               │              │      uses        │       │
               │              │   Resolver to    │       │
               │              ▼   fetch input    ▼       │
               │      ┌──────────────────────────────────┘
               │      │      Resolver
               │      │  resolve(input_ref, root_id) → row stream
               │      │   - file: read JSONL/CSV
               │      │   - sibling/siblings: query collections
               │      │   - concat: recurse + merge
               │      │   - static: pin to past collection_id
               │      │   - grid: synthesize Cartesian rows
               │      └──────────────────────────────────────┐
               │                                             │
               ▼                                             ▼
        ┌─────────────────────────────────────────────────────────┐
        │                    SQLite (nightshift.db)               │
        │   job_definition  /  job_definition_version             │
        │   job_execution   (ledger updates from any worker)      │
        │   collection      /  collection_item (per-row state)    │
        └─────────────────────────────────────────────────────────┘
                                    │
                                    ▼ events via Tauri emit
                                  Frontend
```

Read the diagram top-to-bottom: the Orchestrator owns DefinitionService, Planner, and Dispatcher. On `start_run`, it asks DefinitionService to validate, calls the Planner to produce a plan + initial ledger, then hands control to the Dispatcher. The Dispatcher polls for runnable rows and dispatches each to a Worker matching the row's `kind`. Workers consult the Resolver to materialize their input rows, then write outputs to `collection_item` rows. All component reads/writes go through the same SQLite store — that's the system's blackboard.

### `DefinitionService` (`orchestrator/definition_service.rs`)

CRUD over `job_definition` and `job_definition_version`. Single source of truth for definition content.

- `create_definition(parent_id?, name, kind, position) → def_id` — inserts identity row, no version yet.
- `save_version(def_id, content, message?, created_by) → version_id` — validates content against kind schema, canonicalizes JSON, computes `content_hash`, dedups, inserts (chained via `parent_version_id` to current HEAD), updates `current_version_id`. Returns existing version_id if hash matches HEAD.
- `read_current(def_id) → (JobDefinition, Option<JobDefinitionVersion>)`.
- `read_version(version_id) → JobDefinitionVersion`.
- `list_versions(def_id) → Vec<JobDefinitionVersion>`.
- `rename(def_id, new_name)`, `move_(def_id, new_parent_id, new_position)` — identity mutations only; do not create versions; emit `definition-updated` event.
- `soft_delete(def_id)` — sets `deleted_at`; existing executions remain readable.
- `validate_parent(child_id, proposed_parent_id)` — depth cap (8) + cycle check via recursive CTE.
- `validate_content(kind, mode?, params, input_ref?)` — kind-dispatched JSON-schema validation; returns structured field-level errors for the editor.
- `list_roots() → Vec<JobDefinition>`, `list_by_root(root_id) → Vec<JobDefinition>` for tree views.
- `ensure_all_versions_saved(root_def_id) → Result<(), Vec<def_id>>` — pre-flight check used by `experiment_start`.

### `Planner` (`orchestrator/planner.rs`)

- LLM-backed (reuses existing `reqwest` client + OpenAI-compatible API path).
- `plan(root_def_id) → Plan` — produces structured JSON: `{ phases: [{name, definition_ids, success_criteria}], expected_step_count }`. Concrete; no jargon.
- Model is a config field on the experiment root group's `params`; default `gpt-5-nano` for cost ([OpenAI pricing 2026](https://openai.com/api/pricing/), [CloudZero comparison](https://www.cloudzero.com/blog/openai-pricing/)). Override per-experiment.
- Output validated against a JSON schema (declared in code).
- **P0 scope: planning happens once at `experiment_start`.** No re-plan, no stuck-detection, no rate limits. The happy path is the goal.
- **The planner can create AND edit any definition.** This is the point of the append-only versioning system: every planner edit produces a new `job_definition_version` row (the user's prior version is preserved as a sibling in version history), and `created_by='planner:<root_exec_id>'` tags the provenance. `triggered_by_execution_id` ties the version to the run that produced it. The user can always see what the planner changed and roll back via the history panel.
- **Source flag.** Definitions the planner *creates from scratch* are tagged `source='synthesized'`; definitions it *edits* keep their original `source` (the user wrote the spec; the planner refined it).
- Synthesized-name collision policy: appends `__<counter>` to the proposed name. `tracing::info!` logs the rename.
- Writes the plan to `job_execution.plan` on the root row and seeds `job_execution.ledger` with the initial entries.

### `Dispatcher` (`orchestrator/dispatcher.rs`)

- Polls `job_execution` for runnable rows: `status='pending'` whose dependencies are completed.
- Dependencies: for a child of a `sequential` group, all earlier siblings must be `completed`. For `parallel`, none.
- Hands runnable rows to a `Worker` matching `definition_version.kind`.
- Sequential walking only — `parallel` mode is a structural marker but workers run one at a time in v1 (per scope).

### `Worker` trait + impls (`orchestrator/workers/`)

```rust
trait Worker {
    async fn execute(
        &self,
        exec: JobExecution,
        version: JobDefinitionVersion,
        ctx: WorkerContext,
    ) -> Result<(), WorkerError>;
}
```

- `InferenceWorker` — refactor of existing `JobExecutor::execute_job` body. Iterates over input rows resolved via `Resolver`, makes LLM calls (reusing `attempt_llm_call`, `render_prompt`, `load_prompt_file`), writes `collection_item` rows with full execution state (status, attempt, backend, tokens, latency).
- `AnalysisWorker` — runs the structured analysis agent loop: queries → anecdotes → draft → proofread → optional 1× revise. Tool surface: `list_tables`, `describe_table`, `query` (read-only via `sqlx` connection opened with `read_only(true)`), `check_query`, `fetch_excerpt`, `write_section`. Bounded: 5 SQL exploration turns max, 1 revision pass max. **Appends progress entries to `job_execution.ledger`** (the leaf's own row) after each step; emits `execution-ledger-updated` so the UI re-fetches.
- `JsActionWorker` — **stub returning `WorkerError::NotImplemented`**. Reserved kind in schema; surfaced in UI as "JS actions not yet supported."
- `GroupWorker` — coordinates child execution rows: creates them at start (one per child definition), monitors status transitions, completes the group when all children terminal. No LLM calls. Emits `execution-status` per transition.

### `Resolver` (`orchestrator/resolver.rs`)

Resolves an `input_ref` (stored on a `job_definition_version`) to a concrete stream of input rows at execution time. Each `input_ref.kind` produces input rows from a different source. Concrete examples below; assume the experiment is `treatment_comparison` from the prior worked example, currently executing under `root_id=100`.

#### `kind: 'file'`

```yaml
input_ref: { kind: 'file', path: 'data/seeds.jsonl' }
```

The Resolver reads `data/seeds.jsonl` from the project root. Each line is one input row. If the file has 100 lines, the leaf processes 100 rows and writes 100 `collection_item` rows.

#### `kind: 'sibling'`

```yaml
input_ref: { kind: 'sibling', name: 'gen-low' }
```

Used by the `evaluate` leaf: "feed me the rows that the sibling named `gen-low` produced *in this same run*."

Resolution joins:
1. `job_definition` — find the sibling: `WHERE parent_id = my_def.parent_id AND name = 'gen-low'`. → `def_id=4`.
2. `job_execution` — find that definition's execution within the same root: `WHERE definition_version_id IN (versions of def_id=4) AND root_id = 100`. → `exec_id=103`.
3. `collection` — `WHERE execution_id = 103`. → `collection_id=51`.
4. `collection_item` — `WHERE collection_id = 51 AND status = 'completed' ORDER BY item_index`. → 100 rows of `gen-low`'s outputs.

Those 100 rows become the leaf's iteration set. Each becomes one `collection_item` in the leaf's own collection.

#### `kind: 'siblings'`

```yaml
input_ref: { kind: 'siblings', names: ['evaluate', 'unnest'] }
```

Used by the `analyze` analysis-agent leaf: "I need to query across multiple sibling collections."

Resolution returns N resolved collections (each via the `'sibling'` rule above). The analysis worker doesn't iterate row-by-row over them — it gets *handles* and runs SQL against the underlying tables (`collection_item WHERE collection_id IN (51, 52, 53)` style) through its read-only DB connection.

#### `kind: 'concat'`

```yaml
input_ref:
  kind: 'concat'
  sources:
    - { kind: 'sibling', name: 'gen-control' }
    - { kind: 'sibling', name: 'gen-low' }
    - { kind: 'sibling', name: 'gen-high' }
```

Used by the `unnest` JS-action leaf: "I want all generations from all three treatments as one merged stream."

Resolution recursively resolves each source (3 sibling collections of 100 rows each), then concatenates: 300 rows total. Order: source-major, item_index-minor. The leaf processes 300 rows and writes 300 (or more, for unnesting) `collection_item` rows.

#### `kind: 'static'`

```yaml
input_ref: { kind: 'static', collection_id: 50 }
```

Pin to a specific past collection by id. Bypasses sibling resolution entirely. Useful for sandbox experimentation: "I want to run analysis over yesterday's `gen-control` results without re-running the upstream."

#### `kind: 'grid'`

```yaml
input_ref:
  kind: 'grid'
  dims:
    temperature: [0.2, 0.5, 0.7, 1.0]
    top_p: [0.9, 0.95]
```

Synthesizes input rows from a Cartesian product. The Resolver yields 4 × 2 = 8 rows: `{temperature: 0.2, top_p: 0.9}`, `{temperature: 0.2, top_p: 0.95}`, …. Each row is available to the prompt template via the existing Jinja `{{ data.temperature }}` syntax. Useful for parameter sweeps where the input *is* the sweep.

The Resolver is a single function `resolve(input_ref, root_id) → impl Stream<Item = serde_json::Value>` — it returns a unified row iterator regardless of source kind. Each kind dispatches to its handler, and `concat` recurses.

### `Orchestrator` (`orchestrator/mod.rs`)

Top-level coordinator. Tauri-State singleton.

- Holds: `Arc<DefinitionService>`, `Arc<Planner>`, `Arc<Dispatcher>`, worker registry, event emitter handle.
- `start_run(root_def_id) → root_exec_id` — calls `DefinitionService::ensure_all_versions_saved`, creates root `job_execution`, calls `Planner::plan`, materializes child execution rows for the planned tree, hands to dispatcher. Emits `experiment-started`.
- `cancel_run(root_exec_id)` — sets `cancellation_requested=1` on root `job_execution`; workers poll the flag and abort. Emits `experiment-cancelled` once all children are terminal.
- `resume_pending_on_startup()` — at app launch, scans `job_execution WHERE status IN ('running', 'pending')` and resumes via dispatcher (per-row policy: completed rows untouched; in-flight leaves restart their iteration loop on `pending`/`running` items). On a definitive `failed` execution, the orchestrator marks the root run failed and emits `experiment-failed`; restart of failed runs is out of P0.

## Tauri command + event surface

The legacy command surface (`create_inference_job`, `list_inference_jobs`, `get_inference_job`, `update_inference_job`, `delete_inference_job`, `start_inference_job`, `cancel_inference_job`, `subscribe_to_job_status`, `export_job_to_yaml`, `create_collection`, `add_collection_item`, `get_collection_items`, `get_collection_count`) is **removed**. Its events (`job-started`, `sample-started`, `sample-completed`, `sample-failed`, `job-progress`, `job-completed`, `job-failed`, `job-cancelled`) are **removed**. `list_prompt_files` is kept — useful regardless of orchestrator path.

### New commands

| Command | Returns | Notes |
|---|---|---|
| `definition_create(parent_id?, name, kind, position)` | `def_id` | Identity row, no version yet |
| `definition_save_version(def_id, content, message?)` | `version_id` | `content = {kind, mode, params, input_ref, description}`. Validates against kind schema; dedups by content hash; updates HEAD. Returns structured field-level errors on validation failure. |
| `definition_read_current(def_id)` | `{definition, version: Option<JobDefinitionVersion>}` | Identity + current content (version absent if never saved) |
| `definition_read_version(version_id)` | `JobDefinitionVersion` | Historical content |
| `definition_list_versions(def_id)` | `Vec<JobDefinitionVersion>` | Chronological |
| `definition_rename(def_id, new_name)` | `()` | Identity mutation |
| `definition_move(def_id, new_parent_id?, new_position)` | `()` | Identity mutation |
| `definition_delete(def_id)` | `()` | Soft delete; historical executions still readable |
| `definition_list_roots()` | `Vec<JobDefinition>` | Sidebar source |
| `definition_list_by_root(root_id)` | `Vec<JobDefinition>` | Tree as flat list |
| `experiment_start(root_def_id)` | `root_exec_id` | Pre-flight version check, runs planner, dispatches |
| `experiment_cancel(root_exec_id)` | `()` | Sets `cancellation_requested=1` on root execution |
| `execution_get_tree(root_exec_id)` | `Vec<JobExecution>` | All executions in run |
| `execution_get(exec_id)` | `JobExecution` | Single execution incl. plan/ledger |
| `execution_get_collection(exec_id, page, page_size)` | `Vec<CollectionItem>` | Per-execution output (per-row state visible) |
| `execution_get_ledger(exec_id)` | `Option<serde_json::Value>` | Live agent progress |
| `list_prompt_files(base_path)` | `Vec<String>` | **Kept** from existing surface |

### New events

| Event | Payload | Trigger |
|---|---|---|
| `experiment-started` | `{root_exec_id, root_def_id}` | Run begins |
| `execution-status` | `{exec_id, status, parent_id, error?}` | Any status transition |
| `execution-progress` | `{exec_id, completed, failed, total}` | Per-row transitions in a leaf |
| `execution-ledger-updated` | `{exec_id, entry_count}` | Agent appends ledger entry |
| `experiment-completed` / `experiment-failed` / `experiment-cancelled` | `{root_exec_id, ...}` | Terminal |
| `definition-version-created` | `{def_id, version_id}` | After `save_version` (new row, not dedup hit) |
| `definition-updated` | `{def_id, change: 'rename'\|'move'\|'delete'}` | Identity mutation |

## Frontend: adapt existing components in place

The existing UI is the design. The orchestrator work **renames and rewires** the working components — it does not rebuild them. Below is the canonical mapping; everything is React 19 + CodeMirror 6 + Tauri 2 invoke/listen, same patterns the codebase already uses.

### Component mapping (legacy → adapted)

| Legacy component | New name | What's preserved | What changes |
|---|---|---|---|
| `JobRunnerPage.tsx` | `ExperimentDesignerPage.tsx` | Sidebar + main two-pane layout; selection ↔ form/view switching; the `key={selectedId ?? "new"}` re-mount-on-select pattern. CSS classes (`.job-runner-page`, `.job-runner-main`) reused. | List binds to root `job_definition` rows. Has an internal **design ↔ run** toggle that swaps the right pane between `DefinitionForm` (design) and `ExecutionViewPage` (run). Toggle flips to "run" automatically when `experiment_start` resolves. |
| `JobListSidebar.tsx` | `DefinitionListSidebar.tsx` | Status-badge convention (`status-completed`, `status-running`, `status-failed`, …); type chip in the meta line; `formatRelativeTime` for created-at; `useActiveRefresh` polling at 5s; "+ New" button; loading + empty-state UX. CSS reused (`.job-list-sidebar`, `.job-item`). | Calls `definition_list_roots()`. Status badge derives from version state (`v3` saved / `unsaved` / `deleted`). Type chip shows `kind` (inference / group / analysis / js_action). |
| `InferenceJobForm.tsx` | `DefinitionForm.tsx` | Labeled-fields layout (`.config-section`, `.form-group`, `.form-row`); validation model (`errors: Record<string, string>`, `setErrors` with `submit` for backend rejections, per-field error rendering); file-picker dropdowns sourced from `list_prompt_files` / `list_data_files` / `list_schema_files`; `pickFile` helper with project-root relativization; `Submit` / `Cancel` / `Delete` action row. Provider, model, server URL, output-mode, JSON-schema, sampling-strategy, samples, temperature, max-tokens, thinking-budget fields kept verbatim for `kind=inference`. | Submit calls `definition_create` (new) or `definition_save_version` (existing). Kind dropdown extends the existing inference/transform tab idea: switching kind swaps the body between four sub-forms (inference, group, analysis, js_action). The form composes a `DefinitionContentInput` payload from labeled fields rather than asking the user to write JSON. |
| `JobViewPage.tsx` | `ExecutionViewPage.tsx` | Status banner; progress bar with completed/failed counts; failure list with per-row error; "View Collection" button that switches the App's section to `collection-viewer`; the event-listener cleanup pattern (array of unlisteners). | Listens to `execution-status`, `execution-progress`, `execution-ledger-updated`, `experiment-completed`/`-failed`/`-cancelled` instead of `job-*`. Renders the execution tree (recursive: groups have child execution badges) on top of the existing single-leaf progress UI. Embeds a `LedgerTimeline` panel under any execution that has a non-null `ledger`. Cancel button calls `experiment_cancel`. |
| `CollectionsList.tsx` | **Reused as-is** | Sidebar of collections, selectable; refresh polling. | Internal binding moves from "list collections by job" to "list collections by execution" (same shape, different FK). The component itself doesn't change much — the API call's parameter name does. |
| `CollectionViewer.tsx` | **Reused as-is**, with one extension | Pagination at 50 / page; auto-detected columns from `data` JSON; truncation + expand; search filter; CSV / JSONL export. | Schema now also carries per-row state columns (`status`, `attempt`, `backend`, `latency_ms`, `error`); the viewer surfaces these in collapsible "execution metadata" columns alongside the auto-detected data columns. Failed rows render with a status pill (red) and the error visible on hover. Pending/running rows render as placeholder rows so the user sees progress live. |

### New components (no legacy equivalent)

| Component | Path | Purpose |
|---|---|---|
| `LedgerTimeline.tsx` | `src/components/` | Renders a `job_execution.ledger` JSON value as a timestamped step list. Used by `ExecutionViewPage` for any execution that has a ledger (root planner state + analysis leaves). |
| `DefinitionHistoryPanel.tsx` | `src/components/` | Compact panel under `DefinitionForm` listing past versions chronologically. Click a row to view that version's content (read-only). |
| `src/api/orchestrator.ts` | `src/api/` | Typed wrapper for new Tauri commands. Existing components call `invoke()` directly inline; new orchestrator commands route through this module so signatures live in one place. Doesn't replace the inline-`invoke` pattern in unrelated code; it's additive. |

### App shell changes

`src/App.tsx`:
- The `job-runner` section is **renamed** to `experiment-designer` (was a placeholder using `UnderConstruction`); same icon position, same sidebar pattern. The `Section` union swaps in the new id.
- `experiment-designer` becomes the primary section by default.
- `collection-viewer` retained unchanged — cross-experiment browsing of collections.
- `code-editor` retained unchanged.

### Reused utilities (carry over verbatim)

These are not rewritten; they're imported by the adapted components:
- `useActiveRefresh` ([src/hooks/useActiveRefresh.ts](src/hooks/useActiveRefresh.ts)) — polling-when-active, the same 5-second cadence as today.
- `useToast` / `<ToastProvider>` ([src/components/Toast.tsx](src/components/Toast.tsx)) — every backend error surfaces here. Categories (`"error"`, `"success"`, `"info"`) preserved.
- `formatRelativeTime` ([src/utils/date.ts](src/utils/date.ts)) — created-at display.
- `pickFile` helper (currently a closure inside `InferenceJobForm`) — extract to `src/utils/pickFile.ts` so `DefinitionForm` and any future picker share the project-root relativization. Logic verbatim: open native dialog → `get_root_path` → strip prefix → reject if outside root with a structured error.
- File-listing commands (`list_prompt_files`, `list_data_files`, `list_schema_files`) — kept on the backend, called the same way.
- Inline `invoke()` + `listen()` patterns — preserved. The new `src/api/orchestrator.ts` wrapper is for the new commands only; existing components keep their inline calls.

### Validation + error handling (preserved)

The legacy form's error model is the contract:
- Field-level errors stored as `errors: Record<string, string>` keyed by the field name.
- Backend rejections land in `errors.submit`; rendered as a banner above the action row.
- Toasts for transient feedback (save success, run started, run failed).
- Path-out-of-root errors from the file picker surface as `errors.submit` with a structured message — not a toast — so the user sees it next to where they were working.

`definition_save_version` returns the same `Result<i64, String>` shape as legacy creates. When the backend can return structured field errors (kind-specific schema mismatches), they ride through as `{field_path, message}[]` and the form maps them onto the same `errors: Record<string, string>` map. No new error pipeline is introduced.

## Migration approach

Greenfield. Existing `.nightshift/nightshift.db` files are dropped and recreated; no data migration. The migration framework exists for *future* schema changes (`ALTER`, data backfill, etc.) — it's load-bearing later, not now.

Replace the inline `CREATE TABLE IF NOT EXISTS` in [database.rs](src-tauri/src/database.rs) with a tiny ordered-migration runner:

```rust
struct Migration { version: i64, description: &'static str, up: fn(&SqlitePool) -> BoxFuture<...> }

const MIGRATIONS: &[Migration] = &[
  Migration { version: 1, description: "orchestrator schema", up: m001_orchestrator },
];

async fn run_migrations(pool: &SqlitePool) -> Result<()> {
  // creates schema_version table if missing
  // runs each migration in order, skipping versions already recorded
}
```

- `m001_orchestrator`: creates the five orchestrator tables (`job_definition`, `job_definition_version`, `job_execution`, `collection`, `collection_item`) plus the `schema_version` tracker. No legacy tables — none exist.

`current_version_id` on `job_definition` is **nullable** to handle the chicken-and-egg with `job_definition_version`: identity is created first, content saved second. Freshly-created definitions awaiting their first save have `current_version_id IS NULL` and surface in the sidebar with an "unsaved" badge.

## Critical files

### Backend: to create

- `src-tauri/src/orchestrator/mod.rs` — top-level `Orchestrator` struct + Tauri State setup
- `src-tauri/src/orchestrator/definition_service.rs` — `DefinitionService` (CRUD over `job_definition` + `job_definition_version`, content validation, identity mutations, version dedup via content hash)
- `src-tauri/src/orchestrator/planner.rs` — LLM-driven planner that emits a plan + seeds the root ledger
- `src-tauri/src/orchestrator/dispatcher.rs` — execution-tree walker
- `src-tauri/src/orchestrator/resolver.rs` — `input_ref` resolution
- `src-tauri/src/orchestrator/workers/mod.rs` — `Worker` trait + `WorkerError`
- `src-tauri/src/orchestrator/workers/inference.rs` — `InferenceWorker` (refactor target of existing `JobExecutor::execute_job` body)
- `src-tauri/src/orchestrator/workers/analysis.rs` — `AnalysisWorker` with bounded tool surface
- `src-tauri/src/orchestrator/workers/group.rs` — `GroupWorker`
- `src-tauri/src/orchestrator/workers/js_action.rs` — stub returning `WorkerError::NotImplemented`
- `src-tauri/src/commands/orchestrator.rs` — Tauri command handlers for the new surface
- `src-tauri/src/migrations/mod.rs` — migration runner + `MIGRATIONS` array
- `src-tauri/src/migrations/m001_orchestrator.rs` — sole greenfield migration

### Backend: to modify

- [src-tauri/src/database.rs](src-tauri/src/database.rs) — extract DDL into the migration; thin remaining file to `DatabaseState` only. Legacy command functions that talked to `inference_jobs` get removed wholesale (no callers after the UI rewires).
- [src-tauri/src/job_executor.rs](src-tauri/src/job_executor.rs) — body of `execute_job` becomes `InferenceWorker::execute`. Keep `attempt_llm_call`, `render_prompt`, `load_prompt_file` as helpers used by the worker.
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — replace legacy command registrations with new orchestrator commands; register `OrchestratorState`; call `Orchestrator::resume_pending_on_startup()` after DB init.
- [src-tauri/src/state.rs](src-tauri/src/state.rs) — replace `JobManager` with `OrchestratorState`.
- [src-tauri/src/commands/inference.rs](src-tauri/src/commands/inference.rs) — file renamed to `commands/files.rs`, content trimmed to the file-listing helpers (`list_prompt_files`, `list_data_files`, `list_schema_files`). Legacy execution commands removed.

### Frontend: to adapt in place (rename + rewire)

These keep their visual structure, CSS classes, validation model, polling cadence, and event-listener patterns. The change is which Tauri commands they call and which types they bind to.

- `src/components/JobRunnerPage.tsx` → `ExperimentDesignerPage.tsx` — sidebar+main layout preserved; sidebar wires to definitions, main toggles between `DefinitionForm` and `ExecutionViewPage`.
- `src/components/JobListSidebar.tsx` → `DefinitionListSidebar.tsx` — list of root definitions; status badge now reflects version state; type chip shows kind.
- `src/components/InferenceJobForm.tsx` → `DefinitionForm.tsx` — labeled-fields layout preserved; kind dropdown swaps the body between four sub-forms (inference / group / analysis / js_action). Submit composes a `DefinitionContentInput` and calls `definition_create` + `definition_save_version`.
- `src/components/JobViewPage.tsx` → `ExecutionViewPage.tsx` — progress bar, status banner, failure list, "View Collection" handoff preserved; events swap from `job-*` to `execution-*` / `experiment-*`. Adds a tree view for groups and an embedded `LedgerTimeline`.

Their test files follow the same pattern (rename, retarget assertions). The visual snapshots and DOM structure assertions can stay essentially the same because the underlying classes/markup don't change.

### Frontend: to reuse as-is

These need internal re-binding (FK column change) but no shape change.

- `src/components/CollectionsList.tsx` — list of collections by execution rather than by job.
- `src/components/CollectionViewer.tsx` — paginated table; gains optional execution-state columns (`status`, `attempt`, `backend`, `latency_ms`, `error`) alongside auto-detected data columns. Pending/running rows render as placeholders so live progress is visible.
- `src/components/Toast.tsx` and `ToastProvider` — unchanged.
- `src/hooks/useActiveRefresh.ts` — unchanged.
- `src/utils/date.ts` (`formatRelativeTime`) — unchanged.
- `src/components/Editor.tsx` — unchanged. (YAML / Jinja2 / JSON modes already wired.)

### Frontend: to add

- `src/api/orchestrator.ts` — typed IPC wrapper for new commands and event payloads.
- `src/components/LedgerTimeline.tsx` — renders ledger JSON as a timestamped step list.
- `src/components/DefinitionHistoryPanel.tsx` — version list under the form.
- `src/utils/pickFile.ts` — extracted from the closure inside `InferenceJobForm`; project-root relativization shared by all file pickers.

### Frontend: to modify

- [src/App.tsx](src/App.tsx) — rename `"job-runner"` → `"experiment-designer"` in the `Section` union; wire the new component; `collection-viewer` and `code-editor` sections unchanged.
- [src/database.ts](src/database.ts) — replace the `InferenceJob` interface with the new types (`JobDefinition`, `JobDefinitionVersion`, `JobExecution`, `Collection`, `CollectionItem`); other interfaces (`CollectionItem`'s data shape, etc.) extended in place.

## Reusable existing utilities

### Backend

- **`DatabaseState::new()`** ([database.rs:133](src-tauri/src/database.rs:133)) — connection setup. The migration runner replaces the inline DDL block; connection-string + foreign-keys pragma logic stays.
- **`JobExecutor::attempt_llm_call`** ([job_executor.rs:727](src-tauri/src/job_executor.rs:727)) — LLM POST + retry-on-429. `InferenceWorker` calls into this directly.
- **`JobExecutor::render_prompt`** ([job_executor.rs:815](src-tauri/src/job_executor.rs:815)) — Jinja rendering. Reused by workers that render templates.
- **`JobExecutor::load_prompt_file`** ([job_executor.rs:805](src-tauri/src/job_executor.rs:805)) — project-root-relative file loading.
- **`utils::sanitization::sanitize_name`** ([utils/sanitization.rs](src-tauri/src/utils/sanitization.rs)) — apply to definition names.
- **`commands::file_ops`** path-safety pattern (`target.starts_with(root)` guard) — apply to any worker that touches user files.
- **`tracing::{info,warn,error}`** — sole dev/debug log surface. Functional state lives on rows.
- **mpsc → `app.emit()` event-broadcast pattern** ([commands/inference.rs:84](src-tauri/src/commands/inference.rs:84)) — pattern reused by orchestrator; spawn one drainer task per run.
- **`TEST_LOCK` pattern** ([database.rs:272](src-tauri/src/database.rs:272)) — extend to all orchestrator tests touching the SQLite store.
- **Vitest + `mockInvoke` pattern** ([src/setupTests.ts](src/setupTests.ts)) — extend mocks for new commands.

### Frontend (the UI shape itself)

These are not "utilities" in the helper-function sense — they're load-bearing patterns the working UI is built on. Adopting the new schema means *operating these patterns on different types*, not redesigning them.

- **Two-pane page shape** (`.job-runner-page` flex container with `.job-list-sidebar` + `.job-runner-main`) — `ExperimentDesignerPage` is this layout. Resize-friendly, scroll-isolated, well-tested visually.
- **List-and-detail selection model** — clicking a sidebar row sets `selectedId` in the parent; the detail pane re-mounts via `key={selectedId ?? "new"}`. New definitions show a blank form; existing ones load via `definitionReadCurrent`. This is exactly the legacy `JobRunnerPage` ↔ `JobListSidebar` ↔ `InferenceJobForm` interaction model.
- **Status-badge convention** — `.status-completed` / `.status-running` / `.status-failed` / `.status-pending` / `.status-cancelled` / `.status-warning`. Used in both sidebar items and execution headers. Carries over verbatim — derive from `definition.currentVersionId` for unsaved indication and from `job_execution.status` for runs.
- **Type chip** — small badge in the sidebar item meta-line showing whether a job is "Inference" or "Transform" today. Becomes the `kind` chip for definitions (inference / group / analysis / js_action).
- **Polling-when-active** (`useActiveRefresh`) — auto-refreshes the sidebar when the section is visible; pauses when hidden. 5-second cadence kept.
- **Error pipeline.** Three layers, all preserved:
  1. `errors: Record<string, string>` keyed by field name; rendered via `<span className="field-error">` next to the field.
  2. `errors.submit` for backend rejections; rendered as `<div className="form-error">` above the action row.
  3. `useToast()` / `showToast(message, "error" | "success" | "info")` for transient feedback (run started, save succeeded, etc.).
  Backend kind-schema validation produces `{field_path, message}[]` which the form maps onto layer 1; everything else lands in layer 2 or 3.
- **File-picker pattern.** `pickFile([{name, extensions}])` opens the native dialog, calls `get_root_path`, strips the prefix, and rejects out-of-root paths with a structured message. Today it's a closure inside `InferenceJobForm`; promote to `src/utils/pickFile.ts` so `DefinitionForm` and any future picker share it.
- **File-listing dropdowns.** Backend commands `list_prompt_files` / `list_data_files` / `list_schema_files` populate `<select>` dropdowns at form mount; `project-opened` event re-triggers the load. Pattern unchanged.
- **Event-listener cleanup.** `Promise.all(listen(...))` pattern with array-based unlistener cleanup in `useEffect` return — used by `JobViewPage` today, used by `ExecutionViewPage` tomorrow with the new event names.
- **Auto-detected columns.** `CollectionViewer` walks the first N rows of `data` JSON to discover columns; truncates long values; supports expand. Logic unchanged. Only addition: optional execution-state columns (`status`, `attempt`, `backend`, `latency_ms`, `error`) shown alongside the data columns.
- **Pagination at 50 / page** — `CollectionViewer` and the future cross-execution `CollectionsList` both use this. Same component, same query shape, just different FK on the backing query.
- **Export to JSONL/CSV** — `CollectionViewer`'s existing export buttons. Backend commands rename (now keyed by `collection_id` of an execution-scoped collection), but the frontend handler doesn't change.
- **Confirmation dialogs.** `window.confirm(...)` for destructive actions (delete definition); `useToast` for feedback after — same as legacy job deletion.
- **The `key={selected.id}` re-mount trick** for resetting form state cleanly when selection changes — load-bearing for "switch from definition A to B without form leakage."

## Verification

End-to-end test scenarios that gate "this plan is implemented correctly":

1. **Definition CRUD with DB-native versioning.**
   - Create a `kind=inference` root definition. Verify identity row exists; `current_version_id IS NULL`.
   - `definition_save_version` with valid content → verify version row created, `current_version_id` updated, `parent_version_id IS NULL` (first version).
   - Save the same content again → verify dedup: no new row, returns existing `version_id`, no `definition-version-created` event.
   - Save different content → verify second version row chained via `parent_version_id`.
   - Save invalid content (e.g., wrong shape for `kind=inference` params) → verify structured field-level errors returned, no row created.

2. **Sandbox unified path through the adapted UI.**
   - Open the experiment-designer section. Click `+ New` in the sidebar.
   - Fill the `DefinitionForm` (kind=Inference) using the file-picker dropdowns; submit.
   - Verify the sidebar list refreshes and shows the new definition with a `v1` badge.
   - Click Run. Verify the form pane swaps to `ExecutionViewPage` (the same component that handled `JobViewPage` today).
   - Verify `experiment_start` creates one root `job_execution`, one `collection`, populates `collection_item` rows. Verify per-row state (`status='running'` → `'completed'`) renders live in the embedded `CollectionViewer`.
   - Verify status-badge styling matches today's job-status badges (visual parity with the legacy run experience).
   - Verify the failure list renders the same way for any failed rows (same `.job-failures-section` markup as today).

3. **Identity vs. content mutations.**
   - Rename a definition → `definition_updated` event fires; no new version row.
   - Move a definition (change parent) → identity-only; no new version.
   - Edit `params` → version row created.
   - Verify a running execution against version v1 is unaffected by a subsequent v2 save (FK pinned).

4. **Worked experiment end-to-end.** Build the schema-doc example: `treatment_comparison` with 3 generation children + unnest + evaluate + analyze.
   - Run on a tiny dataset (3 seed rows; samples=2 each).
   - Verify execution tree mirrors definition tree (8 `job_execution` rows in correct parent/child relationship).
   - Verify each leaf's collection has correct row count.
   - Verify `execution_get_collection` for `evaluate` shows rows downstream of `unnest`.
   - Verify the analysis agent appended ledger entries to its `job_execution.ledger`.
   - Verify the `analyze` step produced an `analysis.md` file (output path from the analysis params).

5. **Failure handling (P0 minimum).**
   - Run an experiment; force a leaf to fail (mock LLM returns 500 after retries exhaust).
   - Verify the leaf execution is `status='failed'` with a populated `error`.
   - Verify the parent group's `status='failed'` propagates up to root.
   - Verify `experiment-failed` event fires.
   - (Re-plan / supersedence on failure is deferred to a later phase.)

6. **Restart-resume.**
   - Start an experiment; kill the app mid-execution.
   - Restart; verify `Orchestrator::resume_pending_on_startup` either resumes or marks pending rows.
   - Verify completed rows are not re-run; only `pending`/`running` items in the active leaf restart.

7. **Cycle / depth validation.**
   - Attempt to set a definition's `parent_id` to one of its descendants → reject with structured error.
   - Attempt to insert a 9-deep chain → reject at depth 8.

8. **Versioning reproducibility.**
   - Run an experiment with definition `D` at version `v1`.
   - Save a new version `v2` of `D`; run again.
   - Replay the first run by re-reading its execution tree → verify all rows still resolve to `v1`'s content (FK is preserved through `v2`'s creation).

9. **Planner edits a user definition.**
   - Run an experiment whose root group has a child with `params` the planner deems incorrect.
   - Verify the planner saves a new version with `created_by='planner:<root_exec_id>'`, `triggered_by_execution_id` set.
   - Verify the original user version is preserved in `definition_list_versions`.
   - Verify the planner's edit became `current_version_id`; the run executes against the planner's version.

10. **Cancellation semantics.**
    - Start a long-running experiment; click Cancel.
    - Verify `cancellation_requested=1` set on root execution.
    - Verify in-flight workers abort within their next poll cycle.
    - Verify `experiment-cancelled` event fires once all children are terminal.
    - Verify already-completed rows are preserved (status='completed', not retroactively cancelled).

11. **UI parity with legacy where it matters.**
    - Open a definition with a saved version and a completed execution. Verify the failure list, status badge, progress bar, and "View Collection" button look and behave the same as today's `JobViewPage`.
    - Open the `CollectionViewer` for a completed execution's output. Verify pagination, auto-detected columns, search filter, JSONL/CSV export work identically to today.
    - Verify form-field validation produces inline errors the same way as today's `InferenceJobForm` (one example: leave `prompt_file` empty, submit, see `field-error` next to that field).

12. **Rust + TS test coverage.**
    - Per-module Rust unit tests (TEST_LOCK + temp dirs) for: `DefinitionService`, `Resolver`, each `Worker` impl, `Planner`.
    - Vitest tests for adapted components: `ExperimentDesignerPage`, `DefinitionListSidebar`, `DefinitionForm` (one test per kind sub-form), `ExecutionViewPage`, `LedgerTimeline`, `DefinitionHistoryPanel`, `src/api/orchestrator.ts`. Where the legacy test asserted the same DOM/markup/behavior the adapted component still produces, port the assertion verbatim — those tests are coverage for the visual contract that's being preserved.
    - Reused-as-is components (`CollectionsList`, `CollectionViewer`, `Toast`, `Editor`, `useActiveRefresh`) keep their existing tests; only the FK/parameter-name changes get new assertions.
    - Integration test (Rust): full experiment run with mocked HTTP via `mockito`.

## Risks & open decisions

1. **Re-plan, stuck-detection, and supersedence are deferred.** P0 plans once at run start. If the planner emits a bad plan, the run fails and the user fixes it manually (edit definitions, re-run). Adding re-plan, retry, and supersedence is a follow-up phase with its own design pass.

2. **Planner editing user definitions.** Architecturally allowed; preserved by append-only versioning. P0 verifies the mechanism (test scenario 9). UX guardrails (e.g., "the planner wants to edit `evaluate` — accept / reject?") are a future polish item.

3. **Synthesized-name collision.** Planner suffixes `__<counter>` and `tracing::info!`s the rename. Hard-fail rejected as too brittle.

4. **Per-kind editor experience.** v1 edits `params` and `input_ref` as JSON in CodeMirror's existing JSON mode. Form-builder editors per kind are a future plan.

5. **YAML export/import deferred.** Definition state is DB-native. The content tuple `{kind, mode, params, input_ref, description}` is straightforwardly serializable when that work lands.

6. **Legacy `inference_jobs` migration is one-way.** Pre-existing rows become flat root definitions with a single auto-created version. Existing users see their sandbox jobs in the new designer on first launch.

7. **No schema migrations beyond what `m001`–`m003` cover in P0.** The migration shim accepts arbitrary SQL but P0 only uses `CREATE TABLE`, `INSERT … SELECT`, and `DROP TABLE`. The framework is in place for future additive or non-additive changes.

8. **Editor language modes.** YAML and Jinja2 are already wired in `Editor.tsx`. Definition content uses CodeMirror's JSON mode in the dedicated designer panel.

9. **Editing during a live run.** Safe by construction (executions pin to `definition_version_id`). The UI shows a "version pinned" indicator on running nodes. Saving a new version mid-run does not affect that run.

10. **Soft delete vs. hard delete of definitions.** Decided: soft delete (`deleted_at`). Hard delete would orphan `definition_version_id` FKs from historical executions.

11. **Group execution semantics in P0.** Both `mode='sequential'` and `mode='parallel'` are accepted in the schema, but the dispatcher walks sequentially. `mode='parallel'` is a structural marker that real concurrency will respect once implemented.

12. **`InferenceWorker`'s consumption of upstream collections.** When `input_ref.kind = 'sibling'`, the resolver fetches `WHERE status='completed' ORDER BY item_index`. Failed rows in the upstream are skipped (not retried, not surfaced) in P0 — the worker treats the upstream collection as a stream of successful rows. Surfacing partial-failure semantics to downstream consumers is a future concern.
