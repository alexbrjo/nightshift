import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

let db: Database.Database | null = null

export function initDatabase(userDataPath: string): void {
  const dbDir = path.join(userDataPath, 'data')
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }
  const dbPath = path.join(dbDir, 'nightshift.db')
  db = new Database(dbPath)
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      schema_json TEXT
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      rendered_prompt TEXT,
      raw_response TEXT,
      parsed_content TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      latency_ms REAL,
      status TEXT NOT NULL,
      error TEXT,
      FOREIGN KEY (collection_id) REFERENCES collections(id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template_path TEXT,
      input_files TEXT,
      sampling_strategy TEXT NOT NULL,
      provider_config TEXT,
      output_format TEXT,
      schema_path TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stages_json TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT,
      run_number INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      metrics_json TEXT,
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
    );
  `)
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export interface CollectionRow {
  id: string
  name: string
  created_at: number
  schema_json?: string
}

export interface CollectionItemRow {
  id: string
  collection_id: string
  rendered_prompt?: string
  raw_response?: string
  parsed_content?: string
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  latency_ms?: number
  status: string
  error?: string
}

export function insertCollection(data: CollectionRow): void {
  const db = getDatabase()
  const stmt = db.prepare(`
    INSERT INTO collections (id, name, created_at, schema_json)
    VALUES (@id, @name, @created_at, @schema_json)
  `)
  stmt.run(data)
}

export function insertCollectionItem(data: CollectionItemRow): void {
  const db = getDatabase()
  const stmt = db.prepare(`
    INSERT INTO collection_items (id, collection_id, rendered_prompt, raw_response, parsed_content,
      prompt_tokens, completion_tokens, total_tokens, latency_ms, status, error)
    VALUES (@id, @collection_id, @rendered_prompt, @raw_response, @parsed_content,
      @prompt_tokens, @completion_tokens, @total_tokens, @latency_ms, @status, @error)
  `)
  stmt.run(data)
}

export function getCollections(): CollectionRow[] {
  const db = getDatabase()
  return db.prepare('SELECT * FROM collections ORDER BY created_at DESC').all() as CollectionRow[]
}

export function getCollectionItems(collectionId: string): CollectionItemRow[] {
  const db = getDatabase()
  return db.prepare('SELECT * FROM collection_items WHERE collection_id = ?').all(collectionId) as CollectionItemRow[]
}
