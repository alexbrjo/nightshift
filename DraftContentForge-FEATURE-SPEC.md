# DraftContentForge - Feature Specification

## Overview
A web-based workbench for iterating on LLM prompts, evaluating output quality, and curating structured datasets for model training.

---

## Feature Category 1: Prompt & Spec Authoring

### Description
A comprehensive editor for creating, modifying, and managing the core building blocks of LLM workflows: Content Specs (data structure definitions), Prompt Specs (Jinja2 templates with variables), Eval Specs (evaluation criteria), Transform Specs (JavaScript data transformation scripts), and Data Files (input datasets). Users can create multiple specs, link them together, configure defaults, and manage their entire project through a unified interface.

### Key Capabilities
- Create and edit JSON Schema definitions for structured output data
- Build Jinja2 prompt templates with real-time variable detection and default value configuration
- Define evaluation criteria using pass/fail conditions
- Write JavaScript transformation scripts for post-processing generated content
- Upload and manage structured data files (CSV, JSONL, TXT) for batch generation
- Link specs together to create dependency chains (e.g.,Prompt Spec → Content Spec)
- Configure spec properties like names, linked resources, and file types
- Import/export entire projects as portable JSON archives

### User Workflows
1. **Creating a new LLM workflow**: User creates a Content Spec (JSON schema), then a Prompt Spec that references it, links them together
2. **Iterating on a prompt**: User edits template text, sees detected variables automatically suggested for default value configuration
3. **Batch processing**: User uploads a data file, creates a Transform Spec to reshape it, runs transformation job
4. **Setting up evaluation**: User creates an Eval Spec linked to a Content Spec, defines evaluation criteria
5. **Project portability**: User exports complete project configuration to share or archive, imports later to restore

### Requirements
- Real-time code editor with syntax highlighting for JSON, Jinja2, and JavaScript
- Automatic variable extraction from templates (Jinja2 `{{ var }}` patterns)
- Drag-and-drop or dropdown-based spec linking for creating relationships
- Validation of JSON schema syntax and template variable references
- Support for multiple file formats (CSV, JSONL, TXT)
- Versioned project export/import without data loss
- Undo/redo capability for editing operations

---

## Feature Category 2: LLM Integration & Generation

### Description
A flexible generation interface for running prompts against multiple LLM providers (OpenAI, Anthropic, local models via OpenAI-compatible APIs). Users configure jobs with prompt templates, sampling strategies (single, random, exhaustive), and various LLM parameters including temperature, token limits, structured output modes, and reasoning settings. Jobs run asynchronously in the background with real-time streaming of results via WebSocket.

### Key Capabilities
- Create generation jobs linked to Prompt Specs with configurable LLM parameters
- Support multiple providers: OpenAI (GPT-4o, o3-mini, GPT-5), Anthropic (Claude Sonnet/Opus/Haiku), and local servers
- Choose between single-sample generation or batch processing from data files (CSV, JSONL, TXT)
- Configure sampling strategies: single (uses default variables), random (random row selection), exhaustive (cycle through all rows)
- Set structured output modes: none, JSON, or JSON Schema with linked Content Spec
- Configure thinking budget for Anthropic reasoning models
- Set pre-render URLs with custom request bodies for RAG or external API integration
- Real-time streaming of generation progress via WebSocket showing chunks as they arrive
- View detailed per-sample results with rendered prompts, raw responses, and parsed content
- Monitor parse failure rates and retry failed samples individually

### User Workflows
1. **Quick test generation**: User selects a Prompt Spec, chooses provider/model, runs single sample
2. **Batch evaluation workflow**: User uploads a data file with topics, creates generation job with "exhaustive" strategy to cycle through all entries
3. **High-throughput generation**: User sets num_samples=100, uses "random" strategy to pick from a large dataset
4. **Structured output validation**: User enables JSON Schema mode, links to Content Spec, tracks parse success rates
5. **Reasoning models**: User selects o3-mini with "high" thinking budget for complex tasks
6. **Live monitoring**: User watches streaming results in real-time as samples complete, identifies issues early

### Requirements
- Live result streaming with WebSocket integration
- Per-sample token usage and latency tracking
- Parse success/failure tracking with strategy info
- Individual sample retry capability without re-running entire job
- support for third-party LLM providers via standardized OpenAI-compatible interface
- Rate limit handling and error recovery
- Visual indicators for streaming, completed, and errored samples

---

## Feature Category 3: Evaluation & Quality Scoring

### Description
A flexible evaluation interface for scoring generated content against user-defined criteria. Users create Eval Specs with either natural language prompts (for LLM-based evaluation) or JavaScript pass conditions (for deterministic checks). Evaluation jobs run against generation outputs or collections, with progress tracking and detailed results showing pass/fail rates, reasoning traces, and error information.

### Key Capabilities
- Create Eval Specs using two evaluation modes: LLM prompt templates or JavaScript pass conditions
- Run evaluation jobs against Generation Jobs (individual samples) or Collections (curated items)
- Configure LLM-based evaluation with provider/model selection and parameter tuning
- Monitor real-time progress with completion counters and pass rate statistics
- View per-item results with verdict (pass/fail/error), reasoning traces, and LLM responses
- Filter and analyze evaluation results across multiple Eval Specs
- Track parse failures, pass rates, and error counts for quality assessment

### User Workflows
1. **Deterministic validation**: User creates Eval Spec with JavaScript pass condition (e.g., `return item.length > 10`), runs against generation job samples
2. **LLM-based grading**: User creates Eval Spec with natural language prompt, runs evaluation against individual items from a generation job or collection
3. **Multi-criteria assessment**: User selects multiple Eval Specs (e.g., "format-check", "accuracy-check", "style-guide"), runs all against same source data
4. **Iterative quality improvement**: User identifies failing samples from evaluation results, revises prompt or content spec, re-runs generation
5. **Progress monitoring**: User watches real-time progress bar during long evaluation runs, sees updated completion counts and pass rates

### Requirements
- Support for both deterministic (JavaScript) and LLM-based evaluation
- Progress tracking with completion statistics
- Detailed result breakdown per item including reasoning traces
- Support for batch evaluation of hundreds/thousands of items
- Error handling with detailed error messages
- Comparison across multiple Eval Specs applied to same source data

---

## Feature Category 4: Dataset Curation & Collections

### Description
A powerful collection system for managing curated datasets. Users transform raw generation outputs into structured collections using Transform Specs (JavaScript mapping functions), then review and export the results. Collections can be sourced from Generation Jobs or existing Collections, enabling multi-stage data processing pipelines.

### Key Capabilities
- Create collections from Generation Jobs or existing Collections with Transform Specs
- Source types: direct generation job samples (parsed only) or previous collection items
- Transform items with JavaScript scripts to reshape, extract fields, or compute derived data
- Browse collection contents in a table view with automatic column detection from JSON Schema
- Pagination for large collections (50 items per page)
- Real-time progress tracking during transform job execution via WebSocket
- View transformation job status (pending/running/completed/failed)
- Delete individual items or entire collections
- Export collections for downstream use

### User Workflows
1. **Basic collection**: User creates a collection directly from a generation job, applies no transform (identity mapping)
2. **Field extraction**: User creates a Transform Spec to extract specific fields from generated JSON, applies to collection
3. **Pipeline construction**: User creates a second collection sourced from first collection with additional transformations
4. **Quality review**: User browses collection items in table view, identifies problematic entries, deletes bad items
5. **Monitoring large jobs**: User watches real-time progress bar as transform processes hundreds of items

### Requirements
- Support for multi-stage transformation pipelines (collection → collection)
- Parse-only filtering: only include successfully parsed generation samples
- Real-time job progress via WebSocket
- Table view with typed columns derived from JSON Schema when available
- Pagination for large result sets
- Item-level delete capability without re-processing entire collection

---

## Feature Category 5: Data Import & Transformation

### Description
A dual-purpose system for importing external data and transforming existing content. Users can upload CSV, JSONL, or TXT files as Data Files for batch generation, and create Transform Specs with JavaScript mapping functions to reshape data between structured formats. The system validates file content upon upload and enforces schema compatibility between source and target transforms.

### Key Capabilities
- Upload data files in three formats: CSV, JSONL (JSON Lines), and TXT
- Validate file content on upload (CSV column parsing, JSONL object validation)
- Create Transform Specs with JavaScript scripts that receive `item` and return transformed data
- Link transforms to Content Specs for input (source schema) and output (target schema)
-Enforce schema compatibility: transform input must match source content spec
- Create Transform Jobs that process Data Files or Collections into new Collections
- Monitor transform job progress with item complete events via WebSocket

### User Workflows
1. **Data ingestion**: User uploads CSV with 100 rows, creates Data File for batch prompt generation
2. **Schema mapping**: User creates Transform Spec with input Content Spec (RAW_RESPONSE), output Content Spec (PROCESSED_RESULT)
3. **Batch transformation**: User creates Transform Job sourced from a Generation Job, applies transform to all parsed samples
4. **Chained processing**: User creates second Transform Spec with different output spec, runs against first transform's collection
5. **Validation enforcement**: System rejects transform job if input schema doesn't match source (e.g., RAW_RESPONSE vs PROCESSED_SCHEMA)

### Requirements
- Client-side file validation before upload (CSV structure, JSONL object format)
- Server-side content validation to catch parsing errors early
- Schema enforcement between transforms and their sources
- Support for complex JavaScript transformations with sandboxed execution
- Automatic column detection from JSON Schema in resulting tables

---

## Feature Category 6: Project Management

### Description
Basic project portability through export and import functionality. Users can archive their entire project (all specs, data files) as a portable ZIP, then restore it later or share with others.

### Key Capabilities
- Export entire project as ZIP archive containing .spec.yaml files and raw data files
- Import projects from ZIP files with conflicts resolved by skip or replace strategy
- Automatic resource ordering: content specs imported first (dependencies for other specs)
- Detailed import report showing created/replaced/skipped counts

### User Workflows
1. **Backup**: User exports project archive before major changes
2. **Resource sharing**: User shares ZIP with teammate who imports and receives all specs
3. **Template reuse**: User imports pre-built project ZIP, chooses replace to update existing resources

### Requirements
- Structured export format using YAML for human readability (.spec.yaml)
- Support for conflict resolution strategies (skip existing vs replace)
- Dependency-aware import order
