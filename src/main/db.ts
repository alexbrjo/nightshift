const Database = require('better-sqlite3');
import { join } from 'path';
import { app } from 'electron';
import { InferenceJob } from '../common/models';

const dbPath = join(app.getPath('userData'), 'nightshift.db');
const db = new Database(dbPath);

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inference_jobs (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_items (
      id TEXT PRIMARY KEY,
      jobId TEXT NOT NULL,
      data TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY(jobId) REFERENCES inference_jobs(id)
    );
    CREATE TABLE IF NOT EXISTS bulk_action_results (
      id TEXT PRIMARY KEY,
      actionName TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      analysisFile TEXT,
      FOREIGN KEY(agentId) REFERENCES agents(id)
    );
  `);
}

export function saveInferenceJob(job: InferenceJob) {
  const stmt = db.prepare('INSERT INTO inference_jobs (id, config, status, createdAt) VALUES (?, ?, ?, ?)');
  stmt.run(job.id, JSON.stringify(job.config), job.status, job.createdAt);
}

export function getInferenceJobs(): InferenceJob[] {
  const stmt = db.prepare('SELECT * FROM inference_jobs');
  const rows = stmt.all() as any[];
  return rows.map(row => ({
    id: row.id,
    config: JSON.parse(row.config),
    status: row.status,
    createdAt: row.createdAt
  }));
}

export function updateInferenceJobStatus(id: string, status: InferenceJob['status']) {
  const stmt = db.prepare('UPDATE inference_jobs SET status = ? WHERE id = ?');
  stmt.run(status, id);
}

export function saveCollectionItem(jobId: string, data: any) {
  const id = Math.random().toString(36).substring(2, 15);
  const stmt = db.prepare('INSERT INTO collection_items (id, jobId, data, createdAt) VALUES (?, ?, ?, ?)');
  stmt.run(id, jobId, JSON.stringify(data), Date.now());
}

export function getCollectionItems(jobId: string): any[] {
  const stmt = db.prepare('SELECT * FROM collection_items WHERE jobId = ?');
  const rows = stmt.all(jobId) as any[];
  return rows.map(row => ({
    id: row.id,
    data: JSON.parse(row.data),
    createdAt: row.createdAt
  }));
}

export function deleteCollectionItem(id: string) {
  const stmt = db.prepare('DELETE FROM collection_items WHERE id = ?');
  stmt.run(id);
}

export function saveBulkActionResult(result: any) {
  const stmt = db.prepare('INSERT INTO bulk_action_results (id, actionName, status, createdAt) VALUES (?, ?, ?, ?)');
  stmt.run(result.id, result.actionName, result.status, result.createdAt);
}

export function getBulkActionResults(): any[] {
  const stmt = db.prepare('SELECT * FROM bulk_action_results');
  return stmt.all() as any[];
}

export function savePipeline(pipeline: any) {
  const stmt = db.prepare('INSERT INTO pipelines (id, config, status, createdAt) VALUES (?, ?, ?, ?)');
  stmt.run(pipeline.id, JSON.stringify(pipeline.config), pipeline.status, pipeline.createdAt);
}

export function getPipelines(): any[] {
  const stmt = db.prepare('SELECT * FROM pipelines');
  const rows = stmt.all() as any[];
  return rows.map(row => ({
    id: row.id,
    config: JSON.parse(row.config),
    status: row.status,
    createdAt: row.createdAt
  }));
}

export function saveAgent(agent: any) {
  const stmt = db.prepare('INSERT INTO agents (id, config) VALUES (?, ?)');
  stmt.run(agent.id, JSON.stringify(agent.config));
}

export function getAgents(): any[] {
  const stmt = db.prepare('SELECT * FROM agents');
  const rows = stmt.all() as any[];
  return rows.map(row => ({
    id: row.id,
    config: JSON.parse(row.config)
  }));
}

export function saveAgentRun(run: any) {
  const stmt = db.prepare('INSERT INTO agent_runs (id, agentId, status, createdAt, analysisFile) VALUES (?, ?, ?, ?, ?)');
  stmt.run(run.id, run.agentId, run.status, run.createdAt, run.analysisFile || null);
}

export function getAgentRuns(agentId: string): any[] {
  const stmt = db.prepare('SELECT * FROM agent_runs WHERE agentId = ?');
  const rows = stmt.all(agentId) as any[];
  return rows.map(row => ({
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    createdAt: row.createdAt,
    analysisFile: row.analysisFile
  }));
}
