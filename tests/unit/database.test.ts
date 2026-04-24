import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'

// Import the database functions directly for testing
const testDbPath = join(__dirname, '..', '__testdb__')

function getTestDb(): Database.Database {
  if (!existsSync(testDbPath)) {
    mkdirSync(testDbPath, { recursive: true })
  }
  const dbPath = join(testDbPath, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create tables (same as in database.ts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      settings TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inference_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      sampling_strategy TEXT NOT NULL DEFAULT 'single', num_samples INTEGER DEFAULT 1,
      template_file TEXT NOT NULL, source_data_type TEXT NOT NULL DEFAULT 'file',
      source_data_path TEXT, source_data_collection TEXT, api_endpoint TEXT NOT NULL,
      model_name TEXT NOT NULL, output_mode TEXT NOT NULL DEFAULT 'unstructured',
      temperature REAL DEFAULT 0.7, max_tokens INTEGER DEFAULT 4096,
      thinking_budget INTEGER, pre_render_url TEXT, pre_render_json TEXT,
      schema_file TEXT, status TEXT NOT NULL DEFAULT 'pending',
      total_samples INTEGER DEFAULT 0, completed_samples INTEGER DEFAULT 0,
      errored_samples INTEGER DEFAULT 0, results_collection TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_sample_results (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, sample_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', rendered_prompt TEXT, raw_response TEXT,
      parsed_content TEXT, error TEXT, token_usage_prompt INTEGER DEFAULT 0,
      token_usage_completion INTEGER DEFAULT 0, token_usage_total INTEGER DEFAULT 0,
      latency_ms INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collections_meta (
      name TEXT PRIMARY KEY, schema_def TEXT NOT NULL DEFAULT '{}',
      project_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items_test_collection (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)

  return db
}

function cleanup(): void {
  if (existsSync(testDbPath)) {
    rmSync(testDbPath, { recursive: true, force: true })
  }
}

describe('Database operations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = getTestDb()
  })

  afterEach(() => {
    db.close()
    cleanup()
  })

  describe('Project CRUD', () => {
    it('should create a project', () => {
      const id = 'test-project-1'
      const now = Date.now()
      db.prepare(
        'INSERT INTO projects (id, path, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, '/test/path', 'TestProject', '{}', now, now)

      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>
      expect(project).toBeDefined()
      expect(project.name).toBe('TestProject')
    })
  })

  describe('Inference Job CRUD', () => {
    it('should create and update job status', () => {
      const now = Date.now()
      db.prepare(
        'INSERT INTO projects (id, path, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('proj-1', '/test', 'Test', '{}', now, now)

      const jobId = 'job-1'
      db.prepare(
        `INSERT INTO inference_jobs (id, project_id, name, sampling_strategy, template_file, source_data_type,
         api_endpoint, model_name, output_mode, status, total_samples, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(jobId, 'proj-1', 'Test Job', 'single', 'template.j2', 'file', 'https://api.test/v1', 'gpt-4o', 'plain-json', 'pending', 5, now, now)

      const job = db.prepare('SELECT * FROM inference_jobs WHERE id = ?').get(jobId) as Record<string, unknown>
      expect(job.name).toBe('Test Job')
      expect(job.status).toBe('pending')

      // Update status
      db.prepare('UPDATE inference_jobs SET status = ?, updated_at = ? WHERE id = ?').run('running', Date.now(), jobId)
      const updatedJob = db.prepare('SELECT status FROM inference_jobs WHERE id = ?').get(jobId) as { status: string }
      expect(updatedJob.status).toBe('running')
    })

    it('should track completed and errored samples', () => {
      const now = Date.now()
      db.prepare(
        'INSERT INTO projects (id, path, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('proj-2', '/test', 'Test', '{}', now, now)

      const jobId = 'job-2'
      db.prepare(
        `INSERT INTO inference_jobs (id, project_id, name, sampling_strategy, template_file, source_data_type,
         api_endpoint, model_name, output_mode, status, total_samples, completed_samples, errored_samples, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(jobId, 'proj-2', 'Test Job 2', 'single', 'template.j2', 'file', 'https://api.test/v1', 'gpt-4o', 'plain-json', 'running', 3, 1, 0, now, now)

      // Increment completed
      db.prepare('UPDATE inference_jobs SET completed_samples = completed_samples + 1, updated_at = ? WHERE id = ?').run(Date.now(), jobId)
      const job = db.prepare('SELECT completed_samples FROM inference_jobs WHERE id = ?').get(jobId) as { completed_samples: number }
      expect(job.completed_samples).toBe(2)

      // Increment errored
      db.prepare('UPDATE inference_jobs SET errored_samples = errored_samples + 1, updated_at = ? WHERE id = ?').run(Date.now(), jobId)
      const job2 = db.prepare('SELECT errored_samples FROM inference_jobs WHERE id = ?').get(jobId) as { errored_samples: number }
      expect(job2.errored_samples).toBe(1)
    })
  })

  describe('Job Sample Results', () => {
    it('should create and retrieve sample results', () => {
      const now = Date.now()
      db.prepare(
        'INSERT INTO projects (id, path, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('proj-3', '/test', 'Test', '{}', now, now)

      const jobId = 'job-3'
      db.prepare(
        `INSERT INTO inference_jobs (id, project_id, name, sampling_strategy, template_file, source_data_type, api_endpoint, model_name, output_mode, status, total_samples, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(jobId, 'proj-3', 'Test Job 3', 'single', 'template.j2', 'file', 'https://api.test/v1', 'gpt-4o', 'plain-json', 'running', 2, now, now)

      // Create sample results
      db.prepare(
        `INSERT INTO job_sample_results (id, job_id, sample_index, status, rendered_prompt, raw_response, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('result-1', jobId, 0, 'completed', 'Hello {{ name }}', '{"output": "Hi Alice"}', 150, now)

      db.prepare(
        `INSERT INTO job_sample_results (id, job_id, sample_index, status, rendered_prompt, error, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('result-2', jobId, 1, 'errored', 'Hello {{ name }}', 'API timeout', 5000, now)

      const results = db.prepare('SELECT * FROM job_sample_results WHERE job_id = ? ORDER BY sample_index').all(jobId) as Record<string, unknown>[]
      expect(results).toHaveLength(2)
      expect(results[0].status).toBe('completed')
      expect(results[1].status).toBe('errored')
    })
  })

  describe('Collection operations', () => {
    it('should insert and retrieve collection items', () => {
      const item = { name: 'Alice', score: 95 }
      db.prepare(
        `INSERT INTO items_test_collection (id, data, created_at) VALUES (?, ?, ?)`
      ).run('item-1', JSON.stringify(item), Date.now())

      const row = db.prepare('SELECT * FROM items_test_collection WHERE id = ?').get('item-1') as { data: string }
      expect(JSON.parse(row.data)).toEqual(item)
    })

    it('should count collection items', () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO items_test_collection (id, data, created_at) VALUES (?, ?, ?)`
        ).run(`item-${i}`, JSON.stringify({ index: i }), Date.now())
      }

      const countResult = db.prepare('SELECT COUNT(*) as count FROM items_test_collection').get() as { count: number }
      expect(countResult.count).toBe(5)
    })

    it('should delete collection items', () => {
      db.prepare(
        `INSERT INTO items_test_collection (id, data, created_at) VALUES (?, ?, ?)`
      ).run('item-del-1', JSON.stringify({ name: 'test' }), Date.now())

      db.prepare('DELETE FROM items_test_collection WHERE id = ?').run('item-del-1')
      const remaining = db.prepare('SELECT COUNT(*) as count FROM items_test_collection').get() as { count: number }
      expect(remaining.count).toBe(0)
    })

    it('should paginate collection items', () => {
      for (let i = 0; i < 120; i++) {
        db.prepare(
          `INSERT INTO items_test_collection (id, data, created_at) VALUES (?, ?, ?)`
        ).run(`item-${i}`, JSON.stringify({ index: i }), Date.now() + i)
      }

      const page1 = db.prepare('SELECT * FROM items_test_collection ORDER BY created_at DESC LIMIT 50 OFFSET 0').all() as Record<string, unknown>[]
      expect(page1).toHaveLength(50)

      const page2 = db.prepare('SELECT * FROM items_test_collection ORDER BY created_at DESC LIMIT 50 OFFSET 50').all() as Record<string, unknown>[]
      expect(page2).toHaveLength(50)
    })

    it('should search collection items by text', () => {
      db.prepare(`INSERT INTO items_test_collection (id, data, created_at) VALUES (?, ?, ?)`).run('s1', JSON.stringify({ name: 'Alice' }), Date.now())
      db.prepare(`INSERT INTO items_test_collection (id, data, created_at) VALUES (?, ?, ?)`).run('s2', JSON.stringify({ name: 'Bob' }), Date.now())
      db.prepare(`INSERT INTO items_test_collection (id, data, created_at) VALUES (?, ?, ?)`).run('s3', JSON.stringify({ description: 'Alice was here' }), Date.now())

      const results = db.prepare("SELECT * FROM items_test_collection WHERE data LIKE '%Alice%'").all() as Record<string, unknown>[]
      expect(results.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Collection metadata', () => {
    it('should create and retrieve collection meta', () => {
      const now = Date.now()
      db.prepare(
        'INSERT INTO collections_meta (name, schema_def, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('my-collection', JSON.stringify([{ name: 'id', type: 'string' }]), 'proj-1', now, now)

      const meta = db.prepare("SELECT * FROM collections_meta WHERE name = 'my-collection'").get() as Record<string, unknown>
      expect(meta).toBeDefined()
      expect(JSON.parse(meta.schema_def as string)).toHaveLength(1)
    })
  })
})
