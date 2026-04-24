# User Guide

## Installation

### Prerequisites

- Node.js 18+ 
- npm or yarn package manager

### Setup

```bash
git clone <repository-url>
cd nightshift
npm install
```

### Running the Application

```bash
npm run dev
```

This starts the development server with hot-reload enabled. The Electron app will launch automatically.

For production builds:

```bash
npm run build
```

## First Project

1. Launch Nightshift
2. Click **"Open a Project Folder"** on the welcome screen
3. Select an existing directory or create a new one
4. The selected folder becomes your project, with a per-project SQLite database created automatically at `nightshift.db`

Your project can contain:
- Jinja2 prompt templates (`.jinja`, `.jinja2`, `.tmpl`)
- JSON/JSONL data files for input
- CSV files for tabular data
- JavaScript scripts for bulk actions
- YAML pipeline definitions
- JSON Schema files for validation

## Running an Inference Job

1. Navigate to the **Bulk Inference** panel from the sidebar
2. Click **+ New Job** to open the job configuration form
3. Configure your job:
   - **Job Name**: A descriptive name for the job
   - **Model**: The OpenAI-compatible model (e.g., `gpt-4o`, `claude-3-opus`)
   - **API Endpoint**: Your OpenAI-compatible API server URL
   - **Template File**: Path to your Jinja2 prompt template relative to project root
   - **Sampling Strategy**: Choose from Single, Random, or Exhaustive
   - **Number of Samples**: How many samples to process (for single/random strategies)
   - **Source Data Type**: File or Collection
   - **Output Mode**: Unstructured, Plain JSON, or Schema Validated
   - **Temperature**: Sampling temperature (0-2)
   - **Max Tokens**: Maximum response tokens
4. Click **Create & Run Job**

### Monitoring Progress

- Jobs appear in the sidebar job list
- Status badges show: `pending`, `running`, `completed`, or `errored`
- A progress bar shows completion percentage
- Individual sample results display rendered prompts, responses, and latency

### Exporting Job Configuration

Click **Export YAML** on any completed job to save its configuration for reuse.

## Running a Bulk Action

1. Write your JavaScript transformation script in the code editor (create a `.js` file)
2. Navigate to **Collections** panel
3. Select the source collection you want to transform
4. The bulk action interface allows you to:
   - Specify a source collection
   - Reference your JS script file
   - Define a target collection for output results

### Script Format

Your JavaScript function receives each item and should return a transformed object:

```javascript
// Example: enrich items with computed fields
result = {
  ...item,
  score: (item.value ?? 0) * 1.5,
  category: item.value > 50 ? 'high' : 'low',
};
```

## Building a Pipeline

1. Navigate to **Pipelines** panel
2. Click **+ New Pipeline** and give it a name
3. Add stages by specifying:
   - **Stage Name**: Descriptive label
   - **Type**: Inference Job, JS Action, or Analysis Agent
4. Stages execute sequentially — output from one feeds into the next

### Trial Runs

Before running a full pipeline:
1. Click **Trial Run** to execute with a small batch (3 items per stage)
2. Review results to validate prompts, scripts, and configurations
3. If successful, click **Full Run** for complete execution

### Exporting Pipelines

Click **Export YAML** to save your pipeline definition as a reusable YAML file.

## Running an Analysis Agent

1. Configure an analysis agent with:
   - Name and description
   - Analysis queries (SQL-like)
   - Summary template
2. Run the agent standalone or as part of a pipeline
3. Results are written to `analysis.md` in your project directory
4. Agents run in isolated per-run databases for security

### Agent Workflow

Each analysis agent follows this structured process:
1. **Run Analysis Queries** — Execute queries against experiment data
2. **Supplement with Anecdotes** — Add qualitative observations
3. **Write Summary** — Generate a comprehensive summary report
4. **Proof-read Work** — Review and validate findings

### Exporting Findings

Agents can export their results for cross-run or suite-level meta-analysis before cleanup.
