# Nightshift Technical Requirements

## 1 Editor Requirements

- 1.1 User can open a project folder in the editor
- 1.2 User can create, edit, save and delete files in the editor
- 1.3 Editor has syntax checking and syntax highlighting for js, json, jsonl, csv and jinja2

## 2 Bulk Inference Requirements

- 2.1 User can configure an inference job. Parameters:
  - Job name
  - Number of samples and sampling strategy (single, random, or exhaustive)
  - Source jinja2 prompt file and source data (file or collection) to render parameters
  - OpenAI API server hostname, model name
  - output mode (unstructured, plain JSON, or validated against JSON Schema)
  - temperature, token limits, thinking budget
  - pre-render URL + JSON for RAG or external API integration
- 2.2 While the job is running, the status is streamed to the job page
- 2.3 User can see a list of inference jobs on the left sidebar
- 2.4 The output of the job is saved to a collection in a database
- 2.5 Jobs run asynchronously with rate limit handling and error recovery; visual indicators show streaming, completed, and errored states per sample
- 2.6 From the view page, configuration of the job can be exported to a yaml

## 3 Collections Manager Requirements

- 3.1 User can view inference job output as a paginated table (50 items per page)
- 3.2 Columns are auto-detected from the job's JSON Schema definition
- 3.3 User can filter collection rows by search query
- 3.4 User can delete individual items from a collection
- 3.5 User can export collection data to JSONL or CSV

## 4 Bulk Action Requirements

- 4.1 User writes a sandboxed JavaScript function in the editor
- 4.2 User runs the action against a source collection, specifying target collection for output
- 4.3 Parameters: source collection, action script source (editor file), target collection
- 4.4 The JS function executes against each dataset item and returns structured JSON results
- 4.5 Results are saved to the target collection in the same manner as inference jobs

## 5 Experiment Pipeline Requirements

- 5.1 User can chain multiple saved inference jobs and JS action scripts into a visual workflow editor
- 5.2 Jinja2 style parameters (`{{my_variable}}`) are used in configurations to allow experiment groups to change the dependent variable
- 5.3 Output from one stage feeds into the input of the next stage
- 5.4 JSON Schema definitions track contracts between stages
- 5.5 The final pipeline is saved as a YAML definition file
- 5.6 User can run trial runs (small batch per experimental group) to validate prompts, scripts, and evaluation configs before full execution
- 5.7 During execution, a live view shows each stage's progress, aggregate metrics, and streamed results on a single page

## 6 Agent Analysis Requirements

- 6.1 User can launch a post-experiment analysis agent standalone or as part of an experiment pipeline run
- 6.2 Agent configuration can be saved to YAML for reuse
- 6.3 The agent runs in a sandboxed environment with a per-run SQLite database containing cloned tables (schemas, input data, intermediate results)
- 6.4 The agent follows a structured workflow: run analysis queries → supplement quantitative metrics with anecdotes → write summary → proof-read work
- 6.5 The agent reads and writes freely within its scoped database but cannot access data from other runs
- 6.6 Results are written to a single `analysis.md` file
- 6.7 Before cleanup, the agent can export findings for cross-run or suite-level meta-analysis
