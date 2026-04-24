import Database from 'better-sqlite3'
import { join } from 'path'
import { generateId } from '@shared/utils'

const SCHEMA_VERSION = 1

export interface DbConnection {
  db: Database.Database
  projectPath: string
}

function createTables(db: Database.Database): void {
  db.exec(`
    -- Projects table
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      settings TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Inference jobs table
    CREATE TABLE IF NOT EXISTS inference_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      sampling_strategy TEXT NOT NULL DEFAULT 'single',
      num_samples INTEGER DEFAULT 1,
      template_file TEXT NOT NULL,
      source_data_type TEXT NOT NULL DEFAULT 'file',
      source_data_path TEXT,
      source_data_collection TEXT,
      api_endpoint TEXT NOT NULL,
      model_name TEXT NOT NULL,
      output_mode TEXT NOT NULL DEFAULT 'unstructured',
      temperature REAL DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 4096,
      thinking_budget INTEGER,
      pre_render_url TEXT,
      pre_render_json TEXT,
      schema_file TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      total_samples INTEGER DEFAULT 0,
      completed_samples INTEGER DEFAULT 0,
      errored_samples INTEGER DEFAULT 0,
      results_collection TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Job sample results table
    CREATE TABLE IF NOT EXISTS job_sample_results (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES inference_jobs(id),
      sample_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rendered_prompt TEXT,
      raw_response TEXT,
      parsed_content TEXT,
      error TEXT,
      token_usage_prompt INTEGER DEFAULT 0,
      token_usage_completion INTEGER DEFAULT 0,
      token_usage_total INTEGER DEFAULT 0,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Collections metadata table (tracks collection schemas)
    CREATE TABLE IF NOT EXISTS collections_meta (
      name TEXT PRIMARY KEY,
      schema_def TEXT NOT NULL DEFAULT '{}',
      project_id TEXT NOT NULL REFERENCES projects(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Bulk actions table
    CREATE TABLE IF NOT EXISTS bulk_actions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      source_collection TEXT NOT NULL,
      target_collection TEXT NOT NULL,
      script_file TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Pipelines table
    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      yaml_definition TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Pipeline stages table
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
      stage_type TEXT NOT NULL,
      name TEXT NOT NULL,
      order_num INTEGER NOT NULL,
      job_id TEXT,
      action_id TEXT,
      agent_config_id TEXT,
      input_mapping TEXT DEFAULT '{}',
      output_collection TEXT,
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
    );

    -- Pipeline runs table
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
      group_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Pipeline stage run results table
    CREATE TABLE IF NOT EXISTS pipeline_stage_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
      stage_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input_count INTEGER DEFAULT 0,
      output_count INTEGER DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    );

    -- Analysis agent configs table
    CREATE TABLE IF NOT EXISTS analysis_agent_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      description TEXT,
      analysis_queries TEXT DEFAULT '[]',
      summary_template TEXT,
      output_collection TEXT,
      yaml_definition TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Agent runs table
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL REFERENCES analysis_agent_configs(id),
      run_db_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT,
      exported_at INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  // Insert initial schema version if not exists
  const existing = db.prepare('SELECT COUNT(*) as count FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION) as { count: number }
  if (existing.count === 0) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, Date.now())
  }
}

export function initProjectDb(projectPath: string): DbConnection {
  const dbPath = join(projectPath, 'nightshift.db')
  const db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  createTables(db)

  return { db, projectPath }
}

export function closeDb(conn: DbConnection): void {
  conn.db.close()
}

// ─── Prepared statements for common queries ─────────────────────────────

export function getProjectByPath(db: Database.Database, path: string): Record<string, unknown> | null {
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Record<string, unknown> | null
}

export function createProject(db: Database.Database, projectPath: string, name: string): string {
  const id = generateId()
  const now = Date.now()
  db.prepare(
    'INSERT INTO projects (id, path, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, projectPath, name, JSON.stringify({}), now, now)
  return id
}

export function updateProject(db: Database.Database, id: string): void {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export function createInferenceJob(db: Database.Database, job: Record<string, unknown>): string {
  const id = generateId()
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO inference_jobs (id, project_id, name, sampling_strategy, num_samples, template_file,
     source_data_type, source_data_path, source_data_collection, api_endpoint, model_name, output_mode,
     temperature, max_tokens, thinking_budget, pre_render_url, pre_render_json, schema_file,
     status, total_samples, completed_samples, errored_samples, results_collection, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  stmt.run(
    id,
    job.projectId as string,
    job.name as string,
    job.samplingStrategy as string,
    job.numSamples ?? 1,
    job.templateFile as string,
    job.sourceDataType as string,
    (job.sourceDataPath as string) ?? null,
    (job.sourceDataCollection as string) ?? null,
    job.apiEndpoint as string,
    job.modelName as string,
    job.outputMode as string,
    job.temperature ?? 0.7,
    job.maxTokens ?? 4096,
    (job.thinkingBudget as number) ?? null,
    (job.preRenderUrl as string) ?? null,
    (job.preRenderJson as string) ?? null,
    (job.schemaFile as string) ?? null,
    'pending',
    job.totalSamples ?? 0,
    0,
    0,
    (job.resultsCollection as string) ?? null,
    now,
    now
  )

  return id
}

export function updateJobStatus(db: Database.Database, jobId: string, status: string): void {
  db.prepare('UPDATE inference_jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), jobId)
}

export function incrementCompletedSamples(db: Database.Database, jobId: string): void {
  db.prepare(
    'UPDATE inference_jobs SET completed_samples = completed_samples + 1, updated_at = ? WHERE id = ?'
  ).run(Date.now(), jobId)
}

export function incrementErroredSamples(db: Database.Database, jobId: string): void {
  db.prepare(
    'UPDATE inference_jobs SET errored_samples = errored_samples + 1, status = CASE WHEN completed_samples + errored_samples >= total_samples THEN \'errored\' ELSE status END, updated_at = ? WHERE id = ?'
  ).run(Date.now(), jobId)
}

export function createJobSampleResult(db: Database.Database, result: Record<string, unknown>): string {
  const id = generateId()
  const now = Date.now()

  const tokenUsage = result.tokenUsage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined

  db.prepare(
    `INSERT INTO job_sample_results (id, job_id, sample_index, status, rendered_prompt, raw_response,
     parsed_content, error, token_usage_prompt, token_usage_completion, token_usage_total, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    result.jobId as string,
    result.sampleIndex as number,
    result.status as string,
    (result.renderedPrompt as string) ?? null,
    (result.rawResponse as string) ?? null,
    (result.parsedContent as string) ?? null,
    (result.error as string) ?? null,
    tokenUsage?.promptTokens ?? 0,
    tokenUsage?.completionTokens ?? 0,
    tokenUsage?.totalTokens ?? 0,
    (result.latencyMs as number) ?? null,
    now
  )
  return id
}

export function getJobResults(db: Database.Database, jobId: string): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM job_sample_results WHERE job_id = ? ORDER BY sample_index').all(jobId) as Record<string, unknown>[]
}

export function createCollectionMeta(db: Database.Database, name: string, projectId: string, columns: Record<string, string>[]): void {
  const now = Date.now()
  db.prepare(
    'INSERT INTO collections_meta (name, schema_def, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, JSON.stringify(columns), projectId, now, now)
}

export function getCollectionMeta(db: Database.Database, name: string): Record<string, unknown> | null {
  return db.prepare('SELECT * FROM collections_meta WHERE name = ?').get(name) as Record<string, unknown> | null
}

export function updateCollectionMeta(db: Database.Database, name: string, columns: Record<string, string>[]): void {
  db.prepare(
    'UPDATE collections_meta SET schema_def = ?, updated_at = ? WHERE name = ?'
  ).run(JSON.stringify(columns), Date.now(), name)
}

export function createBulkAction(db: Database.Database, action: Record<string, unknown>): string {
  const id = generateId()
  const now = Date.now()
  db.prepare(
    'INSERT INTO bulk_actions (id, project_id, name, source_collection, target_collection, script_file, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, action.projectId as string, action.name as string, action.sourceCollection as string, action.targetCollection as string, action.scriptFile as string, 'pending', now, now)
  return id
}

export function createPipeline(db: Database.Database, name: string, projectId: string): string {
  const id = generateId()
  const now = Date.now()
  db.prepare(
    'INSERT INTO pipelines (id, project_id, name, yaml_definition, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, projectId, name, null, 'draft', now, now)
  return id
}

export function addPipelineStage(db: Database.Database, stage: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO pipeline_stages (id, pipeline_id, stage_type, name, order_num, job_id, action_id, agent_config_id, input_mapping, output_collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId(),
    stage.pipelineId as string,
    stage.stageType as string,
    stage.name as string,
    stage.orderNum as number,
    (stage.jobId as string) ?? null,
    (stage.actionId as string) ?? null,
    (stage.agentConfigId as string) ?? null,
    JSON.stringify(stage.inputMapping ?? {}),
    (stage.outputCollection as string) ?? null
  )
}

export function createPipelineRun(db: Database.Database, pipelineId: string, groupId?: string): string {
  const id = generateId()
  const now = Date.now()
  db.prepare(
    'INSERT INTO pipeline_runs (id, pipeline_id, group_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, pipelineId, groupId ?? null, 'pending', now, now)
  return id
}

export function createAnalysisAgentConfig(db: Database.Database, config: Record<string, unknown>): string {
  const id = generateId()
  const now = Date.now()
  db.prepare(
    `INSERT INTO analysis_agent_configs (id, project_id, name, description, analysis_queries, summary_template, output_collection, yaml_definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    config.projectId as string,
    config.name as string,
    (config.description as string) ?? null,
    JSON.stringify(config.analysisQueries ?? []),
    (config.summaryTemplate as string) ?? null,
    (config.outputCollection as string) ?? null,
    (config.yamlDefinition as string) ?? null,
    now,
    now
  )
  return id
}

export function createAgentRun(db: Database.Database, configId: string, runDbPath: string): string {
  const id = generateId()
  const now = Date.now()
  db.prepare(
    'INSERT INTO agent_runs (id, config_id, run_db_path, status, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, configId, runDbPath, 'pending', now, now)
  return id
}

export function updateAgentRunSummary(db: Database.Database, runId: string, summary: string): void {
  db.prepare('UPDATE agent_runs SET summary = ?, completed_at = ? WHERE id = ?').run(summary, Date.now(), runId)
}

// ─── Helper to create dynamic collection tables ─────────────────────────

export function createCollectionTable(db: Database.Database, collectionName: string): void {
  // Sanitize table name - only allow alphanumeric and underscores
  const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
  db.exec(`CREATE TABLE IF NOT EXISTS items_${safeName} (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
}

export function insertCollectionItem(db: Database.Database, collectionName: string, item: Record<string, unknown>): void {
  const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
  db.prepare(
    `INSERT INTO items_${safeName} (id, data, created_at) VALUES (?, ?, ?)`
  ).run(generateId(), JSON.stringify(item), Date.now())
}

export function insertCollectionItems(db: Database.Database, collectionName: string, items: Record<string, unknown>[]): void {
  const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
  const insert = db.prepare(
    `INSERT INTO items_${safeName} (id, data, created_at) VALUES (?, ?, ?)`
  )

  const insertMany = db.transaction((rows: { id: string; data: string }[]) => {
    for (const row of rows) {
      insert.run(row.id, row.data, Date.now())
    }
  })

  insertMany(
    items.map(item => ({
      id: generateId(),
      data: JSON.stringify(item),
    }))
  )
}

export function getCollectionItems(db: Database.Database, collectionName: string, page: number = 1, pageSize: number = 50): { items: Record<string, unknown>[]; total: number } {
  const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
  const offset = (page - 1) * pageSize

  const totalResult = db.prepare(`SELECT COUNT(*) as count FROM items_${safeName}`).get() as { count: number }

  const rows = db.prepare(
    `SELECT id, data, created_at FROM items_${safeName} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(pageSize, offset) as { id: string; data: string; created_at: number }[]

  return {
    items: rows.map(row => ({ ...JSON.parse(row.data), _id: row.id, _createdAt: row.created_at })),
    total: totalResult.count,
  }
}

export function deleteCollectionItem(db: Database.Database, collectionName: string, itemId: string): void {
  const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
  db.prepare(`DELETE FROM items_${safeName} WHERE id = ?`).run(itemId)
}

export function searchCollectionItems(db: Database.Database, collectionName: string, query: string, page: number = 1, pageSize: number = 50): { items: Record<string, unknown>[]; total: number } {
  const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
  const offset = (page - 1) * pageSize

  // Search across all JSON data using LIKE on the raw text
  const searchPattern = `%${query}%`
  const totalResult = db.prepare(`SELECT COUNT(*) as count FROM items_${safeName} WHERE data LIKE ?`).get(searchPattern) as { count: number }

  const rows = db.prepare(
    `SELECT id, data, created_at FROM items_${safeName} WHERE data LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(searchPattern, pageSize, offset) as { id: string; data: string; created_at: number }[]

  return {
    items: rows.map(row => ({ ...JSON.parse(row.data), _id: row.id, _createdAt: row.created_at })),
    total: totalResult.count,
  }
}

export function getCollectionItemCount(db: Database.Database, collectionName: string): number {
  const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
  try {
    const result = db.prepare(`SELECT COUNT(*) as count FROM items_${safeName}`).get() as { count: number }
    return result.count
  } catch {
    return 0
  }
}

export function getAllCollectionNames(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM collections_meta ORDER BY name").all() as { name: string }[]
  return rows.map(r => r.name)
}
