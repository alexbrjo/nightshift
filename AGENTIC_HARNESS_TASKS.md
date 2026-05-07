# Method Agentic Harness Task List

## Goal

Build a new agentic harness for designing and executing repeatable Methods: repeatable DAGs of inference, evaluation, aggregation, and analysis.

The system should use Codex App Server for the agentic design harness, keep a chat-first frontend with Method visualization, and execute frozen Methods through a deterministic Rust DAG executor.

The existing Method naming and persisted Method records should be preserved and evolved. This pivot is not a greenfield replacement of the current `method_*` tables or saved Method folders.

## Product Shape

The product has two distinct modes:

- **Design mode:** a Codex App Server agent collaborates with the user to design a Method.
- **Execution mode:** a deterministic Rust runtime executes a frozen Method DAG.

Codex App Server owns generic agent behavior in design mode: chat, native project exploration, file reading/searching, reasoning, tool-call narration, and conversation flow.

Nightshift owns product state and product semantics: Method drafts, resource references, domain inspection, validation, preflight, frozen manifests, execution, collections, artifacts, auditability, and UI state.

The agent may inspect files with App Server native capabilities, ask questions, propose Method changes, validate drafts through Nightshift domain tools, and explain results. The agent must not be the source of truth for Method state or execution. Once a Method is executed, the frozen definition, input file hashes, execution events, collections, and artifacts must be reproducible and auditable.

For inference and model-based evaluation, reproducible means the exact frozen inputs, configuration, provider profile, content hash, and generated artifacts are preserved. It does not imply identical future model output.

## Architecture Boundary

```text
Chat UI
  -> Tauri command bridge
  -> Codex App Server native agent/session/tools
  -> Nightshift Method domain tools
  -> draft Method state
  -> preflight/freeze tools
  -> frozen Method bundle
  -> deterministic Rust DAG executor
  -> execution events, collections, artifacts
  -> chat narration + graph visualization
```

React is a function of Tauri state. React may own ephemeral UI state such as active panel, current input text, focused artifact, scroll position, and local pending indicators, but durable Method state, agent thread metadata, execution state, settings, events, collections, and artifacts live behind Tauri commands/events.

## Core Design Principles

- Keep the frontend chat-first.
- Keep Method visualization visible beside chat.
- Use Codex App Server for design chat and generic project exploration.
- Do not duplicate Codex App Server native file listing, file reading, search, or agent reasoning unless App Server cannot enforce the required boundary.
- Use Nightshift domain tools only where product semantics matter: drafts, resources, validation, freezing, execution, artifacts, and audit trail.
- Cut the existing direct chat-completions design agent in favor of Codex App Server.
- Use a deterministic Rust executor for frozen Methods.
- Treat the Method definition as the durable product boundary.
- Store secrets only as references to global app settings.
- Never invent missing files silently.
- Bias toward asking the user when inputs are missing or ambiguous.
- Make every execution auditable by Method hash, execution id, node id, job id, collection id, and artifact id.
- Keep local inference jobs pointed at local OpenAI-compatible servers.
- Use Codex App Server for design chat; do not use inference job providers for chat.
- Keep product-owned resource inspection scoped to the opened project root and exclude `.nightshift`, `.git`, `node_modules`, `target`, `dist`, and other generated/dependency folders.

## Chunked Task List

Each chunk should produce a UX-visible improvement and land with the backend pieces needed to make that behavior real. Prefer completing one chunk end-to-end before widening scope.

### 1. Chat Working

UX outcome:

- The Agent/Method workspace is the main first screen.
- The user can send a chat message.
- Assistant responses stream into the chat.
- The UI shows pending, success, and failure states for a turn.
- The app can recover from App Server connection errors without losing the visible conversation.

Backend components:

- Add Codex App Server as the design harness dependency.
- Add a Tauri-owned App Server process manager or connector to a configured App Server binary.
- Use a long-lived bidirectional JSON-RPC JSONL/stdio channel.
- Define one App Server thread per design session.
- Persist enough thread metadata to reconnect to a draft.
- Stream App Server thread, turn, item, message, native tool, and error events into React through Tauri events.
- Remove or retire the current direct OpenAI-compatible chat-completions design agent path.

Tests:

- Unit-test App Server event parsing.
- Integration-test Tauri chat command to App Server bridge with a fake App Server process.
- UI-test sending a message and rendering streamed assistant output.

### 2. Project Inspection From Chat

UX outcome:

- The user can ask the agent what files are available.
- The agent can inspect project files with Codex App Server native project exploration.
- Native tool calls and tool results appear in the chat/event stream with friendly labels.
- Missing, ignored, oversized, or blocked files produce concrete chat-visible errors when they are used as Method resources or domain-inspected files.

Backend components:

- Configure App Server with the opened project root, workspace sandbox, and no network.
- Add design-harness instructions that native project exploration should stay inside the opened root and avoid `.nightshift`, `.git`, `node_modules`, `target`, `dist`, and generated/dependency folders.
- Normalize App Server native tool started, completed, and failed events into UI-friendly timeline events.
- Do not implement custom generic `list_project_files`, `read_project_file`, or search tools unless App Server lacks the required capability.
- Add Nightshift domain inspectors for product semantics:
  - inspect data shape
  - inspect prompt variables
  - inspect JSON schema
  - inspect eval script
- Scope Nightshift domain inspectors to the opened project root.
- Exclude ignored/generated/dependency folders in Nightshift domain inspectors.
- Add size limits and parse-error payloads for domain-inspected files.
- Treat App Server native exploration as conversational context, not as authoritative Method resource attachment.

Tests:

- Unit-test project-root sandbox checks and ignored directory behavior for Nightshift domain inspectors.
- Unit-test prompt variable, data shape, JSON schema, and eval script inspection.
- Unit-test App Server native tool event normalization.
- Integration-test fake App Server native tool events reaching React.
- UI-test visible tool progress and blocked-file/domain-inspection errors.

### 3. Draft Method Creation

UX outcome:

- The user describes a benchmark or Method in chat.
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
- Add Nightshift draft Method tools callable by App Server:
  - get current draft
  - create draft
  - update draft metadata
  - explain draft
  - reset draft
- Keep draft state behind Tauri commands/events.
- Let App Server propose draft content, but let Nightshift create, store, and validate draft state.

Tests:

- Unit-test Method lifecycle/state transitions.
- Unit-test draft creation defaults and required field handling.
- Integration-test agent creates a draft through Nightshift domain tools.
- UI-test draft panel appears after a chat request.

### 4. Method Resource Creation And Attachment

UX outcome:

- The user can attach or name prompt, data, JSON schema, eval script, collection, and secret-reference resources.
- The Method panel shows resources, file status, and which nodes consume each resource.
- The agent asks targeted questions when a needed resource is missing or ambiguous.

Backend components:

- Let App Server discover candidate files through native project exploration.
- Require attachment and resource validation to go through Nightshift domain tools:
  - inspect method resource
  - attach method resource
  - detach method resource
  - resolve collection resource
  - resolve secret reference
- Add Method resource reference types:
  - prompt file
  - data file
  - JSON schema file
  - eval script
  - collection
  - secret reference
- Validate file resources are inside the opened project root and outside ignored/generated/dependency folders.
- Validate resource kind matches intended node use.
- Add local inference server profiles and model defaults to `.nightshift/config.json`.
- Let Methods reference provider profiles and secret ids.
- Local server URLs and model names may live in config.
- Secret values must not be stored in Method files.
- Store secrets securely, not in Method files.
- Add resource-to-node input contract validation.

Tests:

- Unit-test resource reference parsing and validation.
- Unit-test `.nightshift/config.json` loading and provider profile resolution.
- Integration-test attaching files and collections to a draft Method through App Server domain tool calls.
- UI-test missing-resource prompts and resource status display.

### 5. Graph Patch Loop

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
  - propose Method patch
  - apply Method patch
  - validate Method graph
- App Server may reason about and propose patches, but Nightshift must validate and apply them.
- Normalize graph data before validation and hashing:
  - sorted node ids
  - sorted edge list
  - stable object key ordering

Tests:

- Unit-test patch application and rejection.
- Unit-test DAG acyclicity and node reference validation.
- Unit-test node config parsing.
- Integration-test graph changes from App Server domain tool calls.
- UI-test graph updates after draft patches.

### 6. Method Preflight View

UX outcome:

- The Method panel shows readiness, blockers, and warnings.
- Save/freeze and execute controls stay disabled until the Method is ready.
- Chat asks concrete questions for the first actionable blocker.
- Preflight can be run manually or by the agent, and the result is visible in chat and graph-adjacent UI.

Backend components:

- Add JSON Schema for the Method IR.
- Implement Nightshift validation/preflight tools callable by App Server:
  - validate schema
  - run preflight
  - list blockers
  - list warnings
- Validate Method JSON Schema.
- Validate DAG acyclicity.
- Validate node references.
- Validate required resources exist.
- Validate file resources are inside root and outside ignored/generated/dependency folders.
- Validate file types.
- Validate JSON schemas parse.
- Validate data files parse.
- Validate prompt variables can be satisfied by data or upstream node outputs.
- Validate eval scripts exist when an eval node references one.
- Validate eval outputs can feed aggregate nodes.
- Validate provider/model config exists.
- Validate secret references exist.
- Return structured blockers and warnings.
- Make blockers actionable by the agent and UI.
- Run preflight from Nightshift state only, not from App Server memory.

Tests:

- Unit-test Method schema validation.
- Unit-test all preflight blocker classes.
- Integration-test preflight blocks missing resources.
- Integration-test preflight passes a ready Method.
- UI-test ready state, blockers, warnings, and disabled controls.

### 7. Freeze Method

UX outcome:

- The user can save/freeze a ready Method from a button or chat.
- The Method becomes immutable.
- The UI shows the frozen Method content hash.
- The Method appears in the saved Methods list.

Backend components:

- Freeze only Nightshift draft state that has passed preflight.
- Store frozen Method bundles under `.nightshift/methods` or the evolved saved Method location chosen for compatibility.
- Preserve compatibility with existing saved Method records/folders where practical.
- Store canonical `method.json`.
- Store content-addressed copies of referenced files.
- Store a manifest of file hashes.
- Store no plaintext secrets.
- Store provider/model config needed for reproducibility.
- Store secret references, not secret values.
- Compute a deterministic content hash for the bundle.
- Hash canonical JSON plus content-addressed resource hashes, not incidental filesystem ordering.
- Define export/import format.
- Create/update SQLite records for frozen Methods.
- Add indexes for Method id and Method content hash.
- Let App Server initiate freeze through a Nightshift domain tool, but Nightshift performs hashing, persistence, and immutability checks.

Tests:

- Unit-test canonical JSON serialization.
- Unit-test file hashing and bundle hashing.
- Integration-test freeze creates an immutable bundle.
- Integration-test existing Method records remain readable where practical.
- UI-test saved/frozen Method appears with hash.

### 8. Execute Frozen Method

UX outcome:

- The user can execute only a ready frozen Method.
- The graph shows node status transitions.
- Chat narrates execution started, node started, node completed, node failed, execution completed, and execution failed events.
- The user can cancel execution.

Backend components:

- Execute only frozen Methods.
- Load the frozen Method by content hash or id.
- Build the deterministic Rust DAG executor.
- Materialize nodes in topological order for P0.
- Persist every node status transition.
- Persist every execution event.
- Persist every created job id.
- Persist every output collection id.
- Persist every artifact id.
- Support cancellation.
- Add pause/resume if feasible for current node type.
- Add explicit retry policy per node.
- Design for future parallel execution without implementing it in P0.
- Create/update tables and indexes for executions, execution nodes, execution events, jobs, collections, collection items, and artifacts.
- Let App Server narrate or explain execution events, but never execute the Method DAG.

Tests:

- Unit-test topological execution ordering.
- Unit-test cancellation state handling.
- Integration-test execution creates records and streams events.
- UI-test graph and chat update during execution.

### 9. Inference Node Execution

UX outcome:

- An inference node creates concrete inference jobs against local OpenAI-compatible servers.
- Outputs appear as collections.
- Per-sample failures are visible.
- Method node outputs link to job ids and collection ids.

Backend components:

- Define inference job config:
  - provider
  - server URL or provider profile
  - model
  - prompt resource
  - data resource or upstream collection
  - output mode
  - JSON schema
  - temperature
  - max tokens
  - samples
  - sampling strategy
- Support local OpenAI-compatible inference servers.
- Support model sweeps.
- Store raw outputs in collections.
- Store per-sample failures.
- Link job outputs to Method node outputs.
- Keep inference jobs separate from design chat; design chat uses Codex App Server.
- Do not call inference providers from the renderer or through App Server chat tools.

Tests:

- Unit-test Method inference node to job config conversion.
- Integration-test execution creates an inference job.
- Integration-test inference output collection is linked to the node.
- UI-test job id, collection id, and per-sample failures are visible.

### 10. Eval And Aggregate Results

UX outcome:

- Eval consumes inference outputs.
- Aggregate nodes produce visible metrics.
- Aggregate artifacts appear in the artifact panel.

Backend components:

- Support deterministic script-based eval.
- Support model-based judging eval in the IR if needed, executed through the execution runtime and provider profiles, not App Server design chat.
- Support eval over upstream inference collections.
- Store eval outputs in collections.
- Store eval failures per item.
- Define expected eval output fields.
- Make eval output contracts explicit for aggregate nodes.
- Define aggregate config:
  - source node
  - group by fields
  - metric fields
  - reducers
  - thresholds
- Support common reducers:
  - count
  - mean
  - sum
  - min
  - max
  - pass rate
- Store aggregate output as JSON artifact.
- Link aggregate artifacts to source collections.

Tests:

- Unit-test eval output contracts.
- Unit-test aggregate reducers.
- Integration-test eval consumes inference output.
- Integration-test aggregate creates JSON artifact.
- UI-test aggregate artifact is visible.

### 11. Analysis Artifact

UX outcome:

- An analysis node creates a Markdown artifact.
- The artifact includes aggregate metrics, failure summaries, and references to collections/artifacts.
- The user can preview and export the analysis.
- The agent can explain the analysis from recorded Nightshift artifacts.

Backend components:

- Generate Markdown analysis over execution artifacts.
- Include aggregate metrics.
- Include failure summaries.
- Include links/references to collections and artifacts.
- Store analysis as Markdown artifact.
- Add Nightshift result/artifact tools callable by App Server:
  - list execution events
  - list execution artifacts
  - read execution artifact
  - summarize collection shape
- Allow export.
- Add export for:
  - JSONL collections
  - CSV collections
  - aggregate JSON
  - analysis Markdown
  - frozen Method bundle
- Treat App Server result explanations as narration over recorded artifacts, not as artifact storage.

Tests:

- Unit-test analysis artifact generation from execution artifacts.
- Unit-test artifact/result query tools.
- Integration-test analysis creates Markdown.
- Integration-test artifact export commands.
- Integration-test agent reads execution artifacts through Nightshift tools.
- UI-test analysis preview and export.

### 12. Saved Method Recovery And Revision

UX outcome:

- Reopening the app/project shows previous Methods, executions, artifacts, and collections.
- A saved draft can reconnect to enough App Server thread metadata to continue the design session where possible.
- Old Method data remains visible where practical.
- The user can revise a prior saved/frozen Method or execution without mutating the original frozen bundle.

Backend components:

- Add Method list/get commands.
- Add execution/artifact query commands.
- Load `.nightshift/config.json`.
- Reconnect App Server thread metadata to drafts.
- Preserve existing `methods`, `method_executions`, `method_execution_nodes`, `method_execution_events`, and `method_artifacts` data where practical.
- Add versioning and migration hooks for Method IR changes.
- Add revise-from-saved/frozen/execution flow:
  - create a new draft from prior Method state
  - preserve provenance
  - never mutate executed frozen bundles
- Let App Server propose revisions through the same draft/resource/graph tools used for initial creation.

Tests:

- Integration-test Method, execution, and artifact recovery after restart.
- Integration-test config loading after restart.
- Integration-test revise-from-execution preserves original frozen bundle.
- Unit-test version/provenance rules.
- UI-test saved Methods, previous artifacts, and revision entry points are visible.

## P0 Milestone

P0 is complete when these UX slices work end-to-end:

- Chat works through Codex App Server.
- The agent can inspect project files through Codex App Server native project exploration.
- Nightshift domain inspectors can inspect Method resources with scoped validation.
- The agent can draft and patch Method IR through Nightshift domain tools.
- The user can attach Method resources and see their status.
- Preflight gates save and execute.
- A frozen Method bundle can be saved.
- A frozen Method can execute through the Rust DAG executor.
- Inference creates concrete local OpenAI-compatible jobs.
- Eval consumes inference outputs.
- Aggregate creates a JSON artifact.
- Analysis creates a Markdown artifact.
- Chat and graph show execution progress.
- Saved Methods and prior executions can be recovered after reopening the project.
- Prior saved/frozen Methods can be revised into new drafts without mutating executed bundles.

## Non-Goals For P0

- Reimplementing generic App Server file listing, file reading, search, shell, or agent reasoning.
- Parallel DAG execution.
- Cloud execution.
- Multi-user collaboration.
- Advanced Method migrations.
- Full hosted secret vault.
- Scheduling.
- Complex approval policies.
- Provider-specific non-OpenAI-compatible APIs.
- Transform nodes in P0 Method execution.
- README rewrite before the architecture is implemented.
