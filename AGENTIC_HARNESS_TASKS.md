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
  -> deterministic Rust DAG executor
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

- The user can attach or name prompt, data, JSON schema, eval script, collection, and secret-reference resources.
- The Method panel shows resources, file status, and which nodes consume each resource.
- The agent asks targeted questions when a needed resource is missing or ambiguous.

Backend components:

- Let App Server discover and read candidate files through native project tools.
- Require attachment decisions and durable resource state to go through Nightshift Method tools:
  - attach Method resource
  - detach Method resource
  - resolve collection resource
  - resolve secret reference
- Add Method resource reference types:
  - prompt file
  - data file
  - JSON schema file
  - eval script
  - collection
  - secret reference
- Validate attached file resources are inside the opened project root.
- Reject generated/dependency folders for attached resources.
- Validate resource kind matches intended node use.
- Add local inference server profiles and model defaults to `.nightshift/config.json`.
- Let Methods reference provider profiles and secret ids.
- Local server URLs and model names may live in config.
- Secret values must not be stored in Method files.
- Store secrets securely, not in Method files.
- Add resource-to-node input contract validation.

Do not add generic file readers or broad file inspectors in this chunk. If execution correctness requires a specific parse check, add that check at attachment, validation, freeze, or execution time for that specific resource type.

Tests:

- Unit-test resource reference parsing and validation.
- Unit-test `.nightshift/config.json` loading and provider profile resolution.
- Integration-test attaching files and collections to a draft Method through App Server-triggered Nightshift Method tools.
- UI-test missing-resource prompts and resource status display.

### 3. Graph Patch Loop

UX outcome:

- The agent can add, remove, or update nodes and edges in response to chat.
- The graph visibly updates after every accepted patch.
- Invalid patches produce actionable blockers instead of corrupting the draft.

Backend components:

- Use canonical JSON as the durable Method IR and frozen manifest format.
- Represent the Method as a DAG with graph-native storage: a node map plus explicit edge list.
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
- Keep `transform` out of P0 Method execution. Existing transform job functionality may remain as legacy standalone functionality outside the Method harness.
- Add typed config for each node type.
- Add typed input/output contracts for each node.
- Add Nightshift graph tools callable by App Server:
  - get draft graph
  - apply graph patch
  - validate graph patch
- Validate acyclicity, node existence, edge endpoints, required config, and resource references.
- Store accepted patches through Tauri state and events.

Tests:

- Unit-test graph patch application and rollback on invalid patches.
- Unit-test cycle detection.
- Unit-test node config validation.
- Integration-test graph changes from App Server-triggered Nightshift Method tools.
- UI-test graph updates after a chat request.

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

### 6. Deterministic Rust DAG Executor

UX outcome:

- The user can execute a frozen Method.
- Execution progress appears in the graph and chat.
- Node statuses and failures are clear.

Backend components:

- Implement Rust DAG execution over the frozen manifest.
- Execute nodes only from frozen inputs and config.
- Support P0 node execution:
  - inference
  - eval
  - aggregate
  - analysis
- Use existing local inference job infrastructure where appropriate.
- Keep inference calls in the main/Rust side, never in the renderer.
- Record execution rows and node rows.
- Emit execution events.
- Support pause, resume, and cancel.
- Persist output collections and artifacts.

Tests:

- Unit-test topological execution.
- Unit-test node failure propagation.
- Unit-test pause/resume/cancel state.
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
