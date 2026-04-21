# nightshift: Desktop Experimentation Platform for Autonomous LLM Workflows

## Updated Features
- Desktop-first (Electron/BetterElectron)
- File system first: open projects as directories (no export/import)
  - Continue using SQLite or another database for data generated from an experiment, but filesystem for editor data and experiment pipeline definition
- File-based workflow: .csv, .json, .js, .jinja2 files instead of compound REST objects
  - Example: ContentSpec becomes *.schema.json and a *.html fragment (or another format to define UI)

## New Features

### Sandbox (one-off runs, similar to the previous versions)
- Test prompts and generation parameters
- Inline evaluation of output quality
- Quick iteration on sampling strategies

### Experiment Designer
- Chain generations together (output → input pipeline)
- Track dependencies between experiments
- Visual workflow editor
- Trail experiment pipeline to catch issues before before full run. Runs a small batch per experimental group to validate prompt, script, and eval configurations.

### LM Studio Integration
- Model state management: Load/unload models programmatically
- Switch between local and cloud providers

### Analysis Agents (auto-insight generation)
- Per-experiment-group analysis agent: Post-run evaluation of results, identify patterns, flag anomalies
- Overall experiment suite analysis agent: Cross-group comparison, trend identification, meta-insights
- Automated reporting: Generate summary documents from analysis results
