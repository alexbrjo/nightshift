# Developer Guide

## Architecture Overview

Nightshift is an LLM experimentation platform built as a monorepo with two main layers:

- **Express backend** (`src/server`): A Node.js/Express API server that persists data in a local SQLite database (`better-sqlite3`), serves project files from a configurable directory, and streams job updates over Server-Sent Events (SSE).
- **React frontend** (`src/client`): A Vite-powered SPA using React 18, TypeScript, Tailwind CSS, and Monaco Editor. It communicates with the backend via REST and SSE.

Key capabilities:
- SQLite via `better-sqlite3` with WAL mode for fast reads/writes.
- SSE streaming for real-time job sample updates.
- QuickJS sandbox for untrusted action scripts.
- YAML-based pipeline definitions.

## Project Layout

```
src/
  server/         Express routes, DB layer, sandbox, validation
  client/         React components, pages, API client
  shared/         Shared TypeScript types used by both frontend and backend
tests/
  unit/           Vitest unit tests for server modules
  e2e/            Playwright end-to-end tests for the UI
```

- `src/server/index.ts` bootstraps the Express app and wires up all route modules.
- `src/server/db.ts` manages the SQLite singleton and schema creation.
- `src/client/api.ts` is a thin `fetch` wrapper used by all components.
- `src/shared/types.ts` contains canonical interfaces for Jobs, Samples, Collections, Pipelines, Agents, etc.

## Data Model

The SQLite database contains the following tables:

| Table | Description |
|-------|-------------|
| `jobs` | Stores inference job definitions (config JSON, status, output collection name). |
| `samples` | Individual prompt/response pairs produced by a job. Includes latency, tokens, error, parsed JSON. |
| `collections` | Named result datasets with an optional schema. |
| `collection_items` | Rows inside a collection, each holding a JSON blob. |
| `pipelines` | Multi-stage workflow definitions stored as YAML. |
| `pipeline_runs` | Execution records for pipelines (status, start/end timestamps, optional log). |
| `agents` | Analysis agent configurations stored as YAML. |

All tables use string UUID primary keys and integer millisecond timestamps.

## Running Locally

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start the dev stack** (runs both Vite client and Express server in watch mode)
   ```bash
   npm run dev
   ```
   The UI will be available at `http://localhost:5173` and the API at `http://localhost:3000`.

3. **Run unit tests**
   ```bash
   npm test
   ```

4. **Run E2E tests**
   ```bash
   npm run test:e2e
   ```
   Playwright will start the dev server automatically, run tests in Chromium, and produce an HTML report.
