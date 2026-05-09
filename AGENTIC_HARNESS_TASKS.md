# Method Agentic Harness Task List

## Goal

Build a Method design and execution harness that uses Codex App Server for the agentic design experience and Nightshift for durable Method product state, validation, freezing, execution, artifacts, and auditability.

Codex App Server owns generic agent behavior:

- chat
- model reasoning
- project file listing
- project file reading
- project file writing when the user asks for edits
- search
- project summarization
- native tool-call narration
- conversation flow

Nightshift owns product state and product semantics:

- Method drafts
- saved Methods
- frozen Method bundles
- resource attachment decisions
- validation and preflight
- execution state
- collections
- artifacts
- audit records
- provider profile references
- secret references
- UI state that must persist outside the agent conversation

Nightshift should add tools only where Nightshift is the source of truth. Do not reimplement generic list/read/write/search tools unless product testing later shows a specific gap that Codex App Server cannot cover.

## Product Boundary

```text
Chat UI
  -> Tauri command bridge
  -> Codex App Server native agent/session/tools
  -> Nightshift Method product tools
  -> draft Method state
  -> validation/preflight/freeze
  -> frozen Method bundle
  -> Rust Method workflow executor
  -> execution events, collections, artifacts
  -> chat narration + graph visualization
```

React is a function of Tauri state. React may own ephemeral UI state such as active panel, current input text, focused artifact, scroll position, and local pending indicators. Durable Method state, agent thread metadata, execution state, settings, events, collections, and artifacts live behind Tauri commands/events.

## When To Add Custom Nightshift Tools

Add a custom Nightshift tool only when at least one is true:

- The action changes durable Method state.
- The action must be auditable.
- The action participates in validation, freeze, or execution.
- The action needs access to app settings, collections, secrets, or execution records.
- The model repeatedly fails at a specific important workflow using App Server native tools.
- The UI needs a structured state update that cannot be reliably derived from chat text.

Prefer fewer, more meaningful product tools. Do not add a custom tool merely because the agent could call it.

## Executor Runtime Direction

Before writing a bespoke Method executor, evaluate whether `rs-graph-llm` / `graph-flow` can provide the Rust workflow runtime underneath Nightshift's Method execution layer.

`graph-flow` is conceptually close to LangGraph:

- graph builder with tasks, edges, conditional edges, and a start task
- stateful execution context
- session storage abstraction
- wait-for-input / human-in-the-loop actions
- task-directed next actions such as continue, go to another task, go back, end, or wait for input
- fan-out support for parallel child tasks
- optional LLM integration through Rig

Potential simplification:

- Use `graph-flow` for workflow stepping, task dispatch, pause/resume/wait semantics, and possibly session checkpointing.
- Keep Nightshift responsible for Method IR, frozen bundles, validation, resource resolution, Tauri events, collections, artifacts, and SQLite execution records.
- Build a thin adapter from frozen Method nodes to Rust task implementations:
  - `InferenceTask`
  - `EvalTask`
  - `AggregateTask`
  - `AnalysisTask`
- Implement or adapt `graph-flow` session storage over Nightshift SQLite if the crate is adopted.
- Do not enable Rig/provider calls initially; keep inference calls in the main/Rust side through Nightshift's existing inference infrastructure.

Open design decision:

- If Methods remain strict DAGs, `graph-flow` should be used only if the adapter is thinner than a small in-house DAG executor.
- If Methods evolve into interactive workflows with waits, branches, retries, and human input, `graph-flow` becomes a stronger fit and the Method IR should be renamed from a pure DAG model to a workflow graph model.
- Conditional edges and task next actions must be represented in a serializable Method IR before they are exposed as product features. Do not hide non-serializable Rust closures inside saved Methods.
- The dependency is young. Land a small spike before committing it to the main execution path.

## Remaining Task List

Each chunk should produce a UX-visible improvement and land with the backend pieces needed to make that behavior real. Prefer completing one chunk end-to-end before widening scope.

### 1. Draft Method State

UX outcome:

- The user describes a benchmark or experiment concept in chat.
- A draft Method appears beside chat with title, objective, nodes, edges, resources, readiness, blockers, and warnings.
- The Method graph can render an incomplete draft without pretending it is executable.

Backend components:

- Use `Method` as the canonical product name.
- Preserve current Method data where practical, including existing `method_*` SQLite tables and saved Method folders.
- Define Method lifecycle states:
  - `drafting`
  - `ready`
  - `executing`
  - `completed`
  - `failed`
- Define separate models for:
  - agent thread state
  - draft Method state
  - saved Method state
  - frozen Method bundle state
  - execution state
  - artifact state
- Define draft Method, saved Method, frozen Method, and execution as distinct concepts.
- Create canonical JSON structs for the Method IR.
- Add Nightshift Method tools callable by App Server:
  - get current draft
  - create draft
  - update draft metadata
  - replace draft graph
  - explain current draft
  - reset draft
- Keep draft state behind Tauri commands/events.
- Let App Server inspect project files and propose draft content.
- Let Nightshift create, store, and validate draft state.

Tests:

- Unit-test Method lifecycle/state transitions.
- Unit-test draft creation defaults and required field handling.
- Integration-test agent creates a draft through Nightshift Method tools.
- UI-test draft panel appears after a chat request.

### 2. Method Resource Attachment

UX outcome:

- The user can attach or name prompt, data, JSON schema, eval script, collection, and API-key resources.
- The Method panel shows resources, file status, and which nodes consume each resource.
- The agent asks targeted questions when a needed resource is missing or ambiguous.

Backend components:

- Let App Server discover and read candidate files through native project tools.
- Require attachment decisions and durable resource state to go through Nightshift Method tools:
  - attach Method resource
  - detach Method resource
  - resolve collection resource
  - resolve API-key resource
- Add Method resource reference types:
  - prompt file
  - data file
  - JSON schema file
  - eval script
  - collection
  - API key
- Validate attached file resources are inside the opened project root.
- Reject generated/dependency folders for attached resources.
- Validate resource kind matches intended node use.
- Add local inference server profiles and model defaults to `.nightshift/config.json`.
- Let Methods reference provider profiles and API-key ids.
- Local server URLs and model names may live in config.
- API-key values may live in Nightshift-managed `.nightshift/config.json`, which is private project configuration and should not be committed.
- API-key values must not be stored in Method files or frozen Method bundles.
- Add resource-to-node input contract validation.

Do not add generic file readers or broad file inspectors in this chunk. If execution correctness requires a specific parse check, add that check at attachment, validation, freeze, or execution time for that specific resource type.

Tests:

- Unit-test resource reference parsing and validation.
- Unit-test `.nightshift/config.json` loading and provider profile resolution.
- Integration-test attaching files and collections to a draft Method through App Server-triggered Nightshift Method tools.
- UI-test missing-resource prompts and resource status display.

### 3. File-Backed Graph Editing

UX outcome:

- The agent can add, remove, or update nodes and edges in response to chat.
- The model edits the canonical Method JSON directly using App Server native project file tools.
- The graph visibly updates after Nightshift reloads and validates the edited Method JSON.
- Invalid graph edits produce actionable blockers instead of being treated as executable state.

Backend components:

- Use canonical JSON as the durable Method IR and frozen manifest format.
- Represent the Method as a DAG with graph-native JSON: a node map plus explicit edge list.
- Add top-level Method fields:
  - schema version
  - id
  - title
  - objective
  - resources
  - parameters
  - provider config
  - nodes
  - edges
  - outputs
  - metadata
- Add P0 node types:
  - `inference`
  - `eval`
  - `aggregate`
  - `analysis`
- Keep `transform` out of the canonical P0 Method IR, but preserve existing script-backed `transform` / `eval` execution behavior until the legacy path is intentionally migrated or removed.
- Add typed config for each node type.
- Add typed input/output contracts for each node.
- Do not add custom graph patch tools unless direct file editing proves insufficient in product testing.
- Let App Server use native project file tools to read and edit the canonical Method JSON file.
- Add Nightshift commands/tools only for product-state operations:
  - load or reload Method draft from canonical JSON
  - validate current Method draft
  - explain graph validation results
- Validate acyclicity, node existence, edge endpoints, required config, typed contracts, and resource references after each reload/validation.
- Keep invalid edited graphs renderable as drafts with blockers, but do not allow save/freeze/execute while blockers remain.
- Emit draft/graph updates through Tauri state and events after successful load or validation.

Tests:

- Unit-test canonical Method JSON parsing and serialization.
- Unit-test graph validation leaves invalid edited drafts inspectable without marking them executable.
- Unit-test cycle detection.
- Unit-test node config validation.
- Unit-test resource reference validation from edited JSON.
- Integration-test graph changes made through App Server native file-edit flow and Nightshift reload/validation.
- UI-test graph updates after a chat request edits the Method JSON.

### 4. Validation And Preflight

UX outcome:

- The Method panel shows readiness, blockers, and warnings.
- The agent can explain what is missing.
- The user can ask “is this ready?” and get product-state-backed answers.

Backend components:

- Implement Nightshift validation/preflight tools callable by App Server:
  - validate draft
  - preflight draft
- Validate product truth:
  - required Method fields
  - DAG validity
  - resource attachments
  - resource kind compatibility
  - missing provider profile references
  - missing secret references
  - execution readiness
- Add content-specific parse checks only when required for execution correctness, for example:
  - prompt file is readable at validation/freeze time
  - JSON schema file parses when used as schema-constrained output
  - data source parses in the format required by the consuming node
  - eval script exists and has a supported runtime if execution depends on it
- Return structured blockers and warnings.
- Emit validation updates to React.

Tests:

- Unit-test blockers and warnings.
- Unit-test validation for missing resources and invalid graph state.
- Unit-test content-specific parse checks that are required for execution.
- Integration-test agent asks for readiness and gets validation results through Nightshift tools.
- UI-test readiness and blockers display.

### 5. Save Method

UX outcome:

- A ready draft can be saved, in which case it is frozen.
- The UI clearly distinguishes draft, saved, frozen, and executing states.
- Frozen Methods cannot be mutated in place.

Backend components:

- Add Nightshift freeze tools callable by App Server:
  - freeze Method
  - get frozen Method manifest
- Freeze by:
  - resolving all attached resources
  - copying referenced files into the Method bundle or recording content-addressed references
  - hashing file contents
  - hashing the manifest
  - preserving provider profile ids and secret ids, not secret values
  - writing enough metadata for reproducibility and audit
- Reuse existing saved Method folder behavior where practical.
- Store frozen manifest separately from mutable draft state.

Tests:

- Unit-test content hashing and manifest hashing.
- Unit-test frozen bundle immutability.
- Unit-test secret values are never serialized.
- Integration-test freeze through App Server-triggered Nightshift Method tool.
- UI-test frozen state display.

### 6. Rust Method Workflow Executor

UX outcome:

- The user can execute a frozen Method.
- Execution progress appears in the graph and chat.
- Node statuses and failures are clear.

Backend components:

- Spike `rs-graph-llm` / `graph-flow` against a frozen P0 Method before building more bespoke executor code.
- The spike must prove:
  - frozen Method nodes can be adapted into Rust task implementations
  - execution state can be mirrored into Nightshift SQLite rows
  - node events can be emitted through Tauri
  - pause, resume, cancel, and wait-for-input semantics can be represented cleanly
  - artifacts and output collections remain queryable through Nightshift APIs
  - packaged local app constraints remain acceptable
- If the spike succeeds, implement Method execution as a Nightshift adapter over `graph-flow`.
- If the spike fails, implement a small in-house Rust DAG executor and document the rejected `graph-flow` constraints.
- Execute workflow nodes over the frozen manifest.
- Execute nodes only from frozen inputs and config.
- Support P0 node execution:
  - inference
  - eval
  - aggregate
  - analysis
- Preserve existing script-backed `transform` / `eval` execution behavior during the graph-flow adapter integration because the executor already partially supports it.
- Use existing local inference job infrastructure where appropriate.
- Keep inference calls in the main/Rust side, never in the renderer.
- Record execution rows and node rows.
- Emit execution events.
- Support pause, resume, and cancel.
- Support wait-for-input as a product-visible blocked/paused execution state if `graph-flow` is adopted.
- Persist output collections and artifacts.
- Keep `transform` out of the canonical P0 Method IR, but preserve existing script-backed `transform` / `eval` execution behavior until the legacy path is intentionally migrated or removed.

Tests:

- Unit-test graph/workflow ordering or `graph-flow` adapter task sequencing.
- Unit-test node failure propagation.
- Unit-test pause/resume/cancel state.
- Unit-test wait-for-input behavior if adopted.
- Unit-test SQLite session/execution-state persistence if `graph-flow` is adopted.
- Integration-test a small frozen Method execution.
- UI-test execution progress and failure display.

### 7. Results And Artifacts

UX outcome:

- The user can inspect outputs, collections, failures, and artifacts.
- The agent can explain results using Nightshift-owned execution data.
- The graph links nodes to their outputs.

Backend components:

- Add Nightshift result/artifact tools callable by App Server:
  - list execution artifacts
  - read execution artifact
  - list output collections
  - summarize execution events
- Store artifact metadata:
  - artifact id
  - execution id
  - node id
  - artifact type
  - storage kind
  - storage ref
  - content hash
  - created time
- Keep collection ids and artifact ids visible in execution events.
- Let App Server explain results through chat, but keep Nightshift as source of truth.

Tests:

- Unit-test artifact/result query tools.
- Integration-test agent reads execution artifacts through Nightshift tools.
- UI-test artifact panel and node-output links.
