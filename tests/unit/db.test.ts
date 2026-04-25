import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../src/server/db';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('db', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-db-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initDb creates tables and getDb returns the same instance', () => {
    const db1 = initDb(tmpDir);
    const db2 = getDb();
    expect(db1).toBe(db2);

    const tables = db1
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('jobs');
    expect(names).toContain('samples');
    expect(names).toContain('collections');
    expect(names).toContain('collection_items');
    expect(names).toContain('pipelines');
    expect(names).toContain('pipeline_runs');
    expect(names).toContain('agents');
  });

  it('insert and query a collection', () => {
    const db = initDb(tmpDir);
    db.prepare('INSERT INTO collections (id, name, schema_json, created_at) VALUES (?, ?, ?, ?)').run(
      'c1',
      'test-collection',
      JSON.stringify({ type: 'object' }),
      Date.now()
    );
    const row = db.prepare('SELECT * FROM collections WHERE name = ?').get('test-collection') as {
      name: string;
      schema_json: string;
    };
    expect(row.name).toBe('test-collection');
    expect(JSON.parse(row.schema_json)).toEqual({ type: 'object' });
  });
});
