# LLMContentForge - Feature Specification

## Overview
A workbench for iterating on LLM prompts, evaluating output quality, and curating structured datasets for model training.

---
## Feature Category 1: Spec Authoring & Management

### Description
A comprehensive editor for creating, modifying, and managing the core building blocks of LLM workflows: Content Specs (data structure definitions), Prompt Specs (Jinja2 templates with variables), Eval Specs (evaluation criteria), Transform Specs (JavaScript data transformation scripts), and Data Files (input datasets). Users can create multiple specs, link them together, configure defaults, and manage their entire project through a unified interface.

### Key Capabilities
- Create and edit JSON Schema definitions for structured output data (Content Specs)
- Build Jinja2 prompt templates with automatic variable detection and default value configuration (Prompt Specs)
- Define evaluation criteria using natural language prompts or JavaScript pass conditions (Eval Specs)
- Write JavaScript transformation scripts for post-processing generated content (Transform Specs)
- Upload and manage structured data files (CSV, JSONL, TXT) for batch generation (Data Files)
- Link specs together to create dependency chains (e.g., Prompt Spec references Content Spec for structured output)
- Configure spec properties like names, linked resources, and file types
- Import/export entire projects as portable ZIP archives containing all specs and data files

### User Workflows
1. **Creating a new LLM workflow**: User creates a Content Spec (JSON schema), then a Prompt Spec that references it for structured output, and links them together
2. **Iterating on a prompt**: User edits template text in the Jinja2 editor, sees detected variables automatically suggested for default value configuration with real-time feedback
3. **Batch processing**: User uploads a data file, creates a Transform Spec to reshape it into the desired format, runs transformation job
4. **Setting up evaluation**: User creates an Eval Spec linked to a Content Spec, defines pass/fail criteria using either LLM prompts or JavaScript conditions
5. **Project portability**: User exports complete project configuration to share with teammates or archive for later, imports later to restore entire workflow

### Requirements
- Real-time code editor with syntax highlighting for JSON, Jinja2, and JavaScript editors
- Automatic variable extraction from templates (Jinja2 `{{ var }}` patterns) with real-time suggestions
- Drag-and-drop or dropdown-based spec linking for creating relationships between specs
- Validation of JSON schema syntax and template variable references with clear error messages
- Support for multiple file formats: CSV (comma-separated), JSONL (JSON Lines format with one object per line), and TXT
- Versioned project export/import without data loss, supporting conflict resolution strategies (skip existing vs replace)
- Undo/redo capability for editing operations across all spec types
- Auto-save functionality for editor panels to prevent data loss during long editing sessions

---
## Feature Category 2: LLM Integration & Generation

### Description
A flexible generation interface for running prompts against multiple LLM providers (OpenAI, Anthropic, local models via OpenAI-compatible APIs). Users configure jobs with prompt templates, sampling strategies (single, random, exhaustive), and various LLM parameters including temperature, token limits, structured output modes, and reasoning settings. Jobs run asynchronously in the background with real-time streaming of results via WebSocket.

### Key Capabilities
- Create generation jobs linked to Prompt Specs with configurable LLM parameters
- Support multiple providers: OpenAI (GPT-4o, o3-mini, GPT-5), Anthropic (Claude Sonnet/Opus/Haiku), and local servers via OpenAI-compatible API
- Choose between single-sample generation or batch processing from data files (CSV, JSONL, TXT)
- Configure sampling strategies: single (uses default variables), random (random row selection from data file), exhaustive (cycle through all rows)
- Set structured output modes: none, JSON-only, or JSON Schema with linked Content Spec for validation
- Configure thinking budget for Anthropic reasoning models (Sonnet, Opus, Haiku)
- Set pre-render URLs with custom request bodies for RAG or external API integration
- Real-time streaming of generation progress via WebSocket showing chunks as they arrive live
- View detailed per-sample results with rendered prompts, raw responses, and parsed content
- Monitor parse failure rates and retry failed samples individually without re-running entire job
- Track token usage (prompt/completion tokens) and latency per sample

### User Workflows
1. **Quick test generation**: User selects a Prompt Spec, chooses provider/model (e.g., Claude Sonnet), runs single sample with default variables
2. **Batch evaluation workflow**: User uploads a data file with 100 topics, creates generation job with "exhaustive" strategy to cycle through all entries
3. **High-throughput generation**: User sets num_samples=100, uses "random" strategy to pick from a large dataset of 1000 entries
4. **Structured output validation**: User enables JSON Schema mode, links to Content Spec, tracks parse success rates in real-time
5. **Reasoning models**: User selects o3-mini with "high" thinking budget for complex reasoning tasks requiring chain-of-thought
6. **Live monitoring**: User watches streaming results in real-time as samples complete, identifies issues early and retries individual failures

### Requirements
- Live result streaming with WebSocket integration for sub-second latency updates
- Per-sample token usage and latency tracking for cost monitoring
- Parse success/failure tracking with strategy info displayed in results table
- Individual sample retry capability without re-running entire job
- Support for third-party LLM providers via standardized OpenAI-compatible interface (chat completions API)
- Rate limit handling and error recovery with retry logic
- Visual indicators for streaming, completed, and errored samples in results table
- Error details displayed per sample including stack traces or provider error messages
- Token budget management: max_tokens limit enforced, temperature adjustment (0.0-2.0), thinking budget for Anthropic

---
## Feature Category 3: Evaluation & Quality Scoring

### Description
A flexible evaluation interface for scoring generated content against user-defined criteria. Users create Eval Specs with either natural language prompts (for LLM-based evaluation) or custom logic rules (for deterministic validation). Evaluation jobs run against Generation Jobs (individual samples) or Collections (curated items), with progress tracking and detailed results showing pass/fail rates, reasoning traces, and error information.

### Key Capabilities
- Create Eval Specs using two evaluation modes: LLM prompt templates (for qualitative assessment) or custom logic rules (for deterministic validation)
- Run evaluation jobs against Generation Jobs (individual samples with parsed content) or Collections (pre-curated items)
- Configure LLM-based evaluation with provider/model selection and parameter tuning (max_tokens, temperature)
- Monitor real-time progress with completion counters and pass rate statistics during long-running jobs
- View per-item results with verdict (pass/fail/error), reasoning traces from LLM evaluations, and full LLM responses
- Filter and analyze evaluation results across multiple Eval Specs applied to same source data
- Track parse failures, pass rates, and error counts for comprehensive quality assessment

### User Workflows
1. **Deterministic validation**: User creates Eval Spec with custom logic rule to validate output structure, runs against generation job samples
2. **LLM-based grading**: User creates Eval Spec with natural language prompt (e.g., "Rate the quality on scale 1-5"), runs evaluation against individual items from a generation job or collection
3. **Multi-criteria assessment**: User selects multiple Eval Specs (e.g., "format-check", "accuracy-check", "style-guide"), runs all against same source data to generate comprehensive quality report
4. **Iterative quality improvement**: User identifies failing samples from evaluation results, revises prompt or content spec based on failures, re-runs generation with updated spec
5. **Progress monitoring**: User watches real-time progress bar during long evaluation runs, sees updated completion counts and pass rates update live

### Requirements
- Support for both deterministic (custom logic rules) and LLM-based evaluation modes in Eval Specs
- Progress tracking with completion statistics (x/y items complete) and pass rate calculations
- Detailed result breakdown per item including reasoning traces from LLM evaluations
- Support for batch evaluation of hundreds/thousands of items with parallel processing
- Error handling with detailed error messages for failed evaluations
- Comparison across multiple Eval Specs applied to same source data for side-by-side analysis
- Real-time WebSocket updates for long-running evaluation jobs (same pattern as generation jobs)

---

## Feature Category 4: Dataset Curation & Collections

### Description
A powerful collection system for managing curated datasets. Users create collections by running transformation jobs on sources (Generation Jobs or existing Collections), then review and export the curated results. Collections serve as the primary unit for managing structured LLM output data throughout its lifecycle.

### Key Capabilities
- Create collections from Generation Jobs or existing Collections using Transform Specs to reshape raw generation outputs
- Browse collection contents in a table view with automatic column detection and typing from JSON Schema definitions when available
- Monitor transformation job progress in real-time via WebSocket showing completion percentage and throughput metrics
- Browse large collections with pagination (50 items per page) for efficient memory usage and navigation
- Delete individual items from collections without re-processing entire dataset, for quality control and refinement
- Export collections for downstream use (model fine-tuning, LLM benchmarking, manual review)
- Transform as first-class citizen: collections are fundamentally transformation outputs with full lineage tracking

### User Workflows
1. **Basic collection**: User creates a collection directly from a generation job, applies no transform (identity mapping), reviews all parsed samples in table view
2. **Field extraction**: User creates a Transform Spec to extract specific fields from generated JSON, applies transform job to create curated sub-set
3. **Pipeline construction**: User creates second collection sourced from first collection with additional transformations, building multi-stage data processing pipeline
4. **Quality review**: User browses collection items in table view, identifies problematic entries with parse failures or quality issues, deletes bad items individually
5. **Monitoring large jobs**: User watches real-time progress bar as transform processes hundreds of items, sees completion percentage and throughput metrics

### Requirements
- Support for multi-stage transformation pipelines (collection → collection chaining)
- Parse-only filtering: optionally include only successfully parsed generation samples when creating collection
- Real-time job progress via WebSocket (item_complete events with completed/total counts)
- Table view with typed columns derived from JSON Schema when available
- Pagination for large result sets (50 items per page, configurable offset)
- Item-level delete capability without re-processing entire collection
- Source validation: transform job must specify valid source (generation job or collection)
- Transform spec validation: input Content Spec must match source data structure
- Error handling with resume capability for failed transforms

---

## Feature Category 5: File & Project Management

### Description
A unified file management system for handling Data Files and project portability. Users upload external data files for batch generation, manage them through editing workflows, and export/import entire projects for backup, sharing, and migration.

### Key Capabilities
- Upload data files in three formats: CSV (comma-separated values), JSONL (JSON Lines with one object per line), and TXT (plain text)
- Validate file content on upload: CSV column parsing, JSONL object format validation, encoding checks
- Browse and edit imported data files in code editor with syntax highlighting and real-time validation
- Link Data Files to generation jobs as row sources for batch prompt execution
- Support data file updates without recreating from scratch (edit and save)
- Export entire project as ZIP archive containing all specs and data files
- Import projects from ZIP files with configurable conflict resolution (skip vs replace)
- Automatic resource ordering during import (Content Specs first for dependencies)
- Detailed import report showing counts of created, skipped, and replaced resources
- Version tracking in exported files for forward/backward compatibility

### User Workflows
1. **Data ingestion**: User uploads CSV with 100 rows of topic data, creates Data File for batch prompt generation jobs
2. **Format conversion**: User uploads JSONL file with pre-structured data, uses as direct row source for generation
3. **Plain text processing**: User uploads TXT file with prompts or instructions, creates Data File for batch generation
4. **Datafile editing**: User edits existing Data File content directly in editor, saves changes without recreating
5. **Project backup**: User exports complete project archive before major changes, stores in safe location
6. **Resource sharing**: User shares ZIP with teammate who imports and receives all specs, selects "skip" to preserve local customizations
7. **Template reuse**: User imports pre-built project ZIP from community, chooses "replace" to update existing resources
8. **Migration**: User exports project from old environment, imports to new environment, resolves version conflicts

### Requirements
- Client-side file validation before upload (CSV structure, JSONL object format)
- Server-side content validation to catch parsing errors early with detailed error messages
- Syntax highlighting for JSONL (JSON) and plain text modes in editor
- Support for large data files with streaming upload capability
- Error localization: highlight specific line numbers where parsing fails
- Structured export format using YAML for human readability (.spec.yaml extension, one file per resource)
- Conflict resolution strategies: skip existing (preserve local), replace with new (overwrite local)
- Dependency-aware import order: Content Specs first, then Prompt/Transform/Eval Specs
- Import validation and feedback: report success rate, list unresolved dependencies, highlight conflicts
- Rollback safety: export before import to enable recovery if import fails
- File integrity: ZIP archive contains checksums or hashes for verification

---

