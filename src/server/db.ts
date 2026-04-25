import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database.Database | null = null;
let currentProjectDir: string | null = null;

export function initDb(projectDir: string): Database.Database {
  if (db && currentProjectDir === projectDir) {
    return db;
  }
  if (db) {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
    db = null;
  }
  currentProjectDir = projectDir;
  const dbDir = path.join(projectDir, '.nightshift');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = path.join(dbDir, 'store.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  createTables();
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function getProjectDir(): string {
  if (!currentProjectDir) throw new Error('Project directory not initialized');
  return currentProjectDir;
}

function createTables() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      collection_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS samples (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      prompt TEXT,
      response TEXT,
      parsed TEXT,
      error TEXT,
      latency_ms INTEGER,
      tokens INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_samples_job ON samples(job_id);

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      schema_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_collection ON collection_items(collection_id);

    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_yaml TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER,
      completed_at INTEGER,
      log TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_yaml TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      run_db_path TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}
