# User Guide

## Installation

1. Clone the repository:
   ```bash
   git clone <repo-url> nightshift
   cd nightshift
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

## First Project

When you first open Nightshift, you are in the project workspace. Use the **Files** sidebar to create templates, data files, and scripts.

1. Click the **+** button in the Files panel to create a new file.
2. Create a Jinja template, e.g. `template.jinja`:
   ```jinja
   Hello {{name}}!
   ```
3. Create a data file, e.g. `data.jsonl`:
   ```jsonl
   {"name":"World"}
   ```

## Running an Inference Job

1. Navigate to **Jobs** in the sidebar.
2. Fill the form:
   - **Name**: a descriptive job name.
   - **Samples**: number of samples to run.
   - **Strategy**: `single`, `random`, or `exhaustive`.
   - **Template File**: select the `.jinja` file you created.
   - **Data Source**: choose the `.jsonl` file or an existing collection.
   - **Host**: your LLM API endpoint (e.g. `http://localhost:11434`).
   - **Model**: model identifier.
   - **Output Mode**: `unstructured`, `json`, or `schema`.
   - **Temperature** and **Max Tokens**: inference parameters.
3. Click **Create Job**. The job will appear in the **Existing Jobs** list.
4. Click a job to open its status page and watch samples stream in via SSE.

## Running a Bulk Action

1. Write a JavaScript script that transforms collection rows, e.g. `uppercase.js`:
   ```js
   return { name: data.name.toUpperCase() };
   ```
2. Navigate to **Actions** in the sidebar.
3. Select a **Source Collection**, the **Script File**, and a **Target Collection** name.
4. Click **Run Action**. Each row from the source will be processed in the QuickJS sandbox and saved into the target collection.

## Building a Pipeline

1. Navigate to **Pipelines** in the sidebar.
2. Click **Create Pipeline**.
3. Enter a **Name** and build a sequence of **Stages**:
   - **Type**: `job`, `action`, or `agent`.
   - **Ref**: a job ID or file path.
   - **Config** (optional): JSON object for stage overrides.
4. Use the **Up** / **Down** buttons to reorder stages and **Remove** to delete them.
5. The **YAML Preview** updates in real time as you edit.
6. Click **Save** to store the pipeline.
7. For each pipeline, click **Run Trial** for a quick test or **Run Full** to execute the entire workflow.
8. Expand a pipeline to see its **Run History** with status, start, and completion times.

## Running an Analysis Agent

1. Navigate to **Agents** in the sidebar.
2. Click **Create Agent**.
3. Enter a **Name** and a list of **Queries** (one SQL query per line).
4. Optionally set a **Target Collection** to store results.
5. Click **Save**, then **Run** next to the agent.
6. If an `analysis.md` file exists in the project directory, its contents will be displayed on the Agents page automatically.
7. Click **Export Findings** to download a JSON file containing the agent definition and analysis content.
