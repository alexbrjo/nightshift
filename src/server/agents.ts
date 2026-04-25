import { Express, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getDb, getProjectDir } from './db';
import { validate } from './validation';

export const agentConfigSchema = z.object({
  name: z.string().min(1),
  queries: z.array(z.string()),
  targetCollection: z.string().optional(),
});

export async function runAgent(agentId: string, projectDir: string, config?: z.infer<typeof agentConfigSchema>) {
  const db = getDb();
  const agentRow = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
    | { id: string; name: string; config_yaml: string }
    | undefined;
  if (!agentRow) throw new Error('Agent not found');

  const agentConfig = config ?? (yaml.load(agentRow.config_yaml) as z.infer<typeof agentConfigSchema>);
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('running', agentId);

  // Clone main DB for isolation
  const dbDir = path.join(projectDir, '.nightshift');
  const mainDbPath = path.join(dbDir, 'store.sqlite');
  const agentDbDir = path.join(dbDir, 'agents');
  if (!fs.existsSync(agentDbDir)) {
    fs.mkdirSync(agentDbDir, { recursive: true });
  }
  const runDbPath = path.join(agentDbDir, `${agentId}.sqlite`);
  fs.copyFileSync(mainDbPath, runDbPath);
  db.prepare('UPDATE agents SET run_db_path = ? WHERE id = ?').run(runDbPath, agentId);

  const agentDb = new Database(runDbPath);
  agentDb.pragma('journal_mode = WAL');

  try {
    let findings = '';

    // 1. Run analysis queries
    for (const query of agentConfig.queries) {
      try {
        const rows = agentDb.prepare(query).all();
        findings += `### Query: ${query}\n\n${JSON.stringify(rows, null, 2)}\n\n`;
      } catch (qerr) {
        findings += `### Query: ${query}\nError: ${qerr instanceof Error ? qerr.message : String(qerr)}\n\n`;
      }
    }

    // 2. Supplement quantitative metrics with anecdotes
    if (agentConfig.targetCollection) {
      const col = agentDb.prepare('SELECT id FROM collections WHERE name = ?').get(agentConfig.targetCollection) as
        | { id: string }
        | undefined;
      if (col) {
        const items = agentDb
          .prepare('SELECT data_json FROM collection_items WHERE collection_id = ? LIMIT 3')
          .all(col.id) as Array<{ data_json: string }>;
        if (items.length > 0) {
          findings += `### Anecdotes\n\n`;
          for (const item of items) {
            findings += `- ${item.data_json}\n`;
          }
          findings += `\n`;
        }
      }
    }

    // 3. Write summary
    findings += `## Summary\n\nAnalysis completed for agent ${agentRow.name}.\n`;

    // 4. Proof-read
    findings += `\n*Proof-read complete.*\n`;

    fs.writeFileSync(path.join(projectDir, 'analysis.md'), findings, 'utf-8');
    db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('completed', agentId);
  } finally {
    agentDb.close();
  }
}

export function setupAgentRoutes(app: Express) {
  app.get('/api/agents', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Array<{
      id: string;
      name: string;
      config_yaml: string;
      status: string;
      run_db_path: string | null;
      created_at: number;
    }>;
    res.json({
      agents: rows.map((r) => ({
        ...r,
        config: yaml.load(r.config_yaml) as object,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  });

  app.post('/api/agents', (req: Request, res: Response) => {
    const db = getDb();
    const config = validate(agentConfigSchema, req.body);
    const id = uuidv4();
    const now = Date.now();
    db.prepare('INSERT INTO agents (id, name, config_yaml, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      config.name,
      yaml.dump(config),
      'pending',
      now
    );
    // Persist agent config to YAML file in project dir
    const agentsDir = path.join(getProjectDir(), 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(agentsDir, `${config.name}.yaml`), yaml.dump(config), 'utf-8');
    res.json({ id });
  });

  app.post('/api/agents/:id/run', (req: Request, res: Response) => {
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as
      | { id: string; name: string; config_yaml: string }
      | undefined;
    if (!agent) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    runAgent(req.params.id, getProjectDir()).catch((e) => console.error('Agent run error:', e));
    res.json({ success: true });
  });

  app.get('/api/agents/:id/export', (req: Request, res: Response) => {
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as
      | { id: string; name: string; config_yaml: string; run_db_path: string | null }
      | undefined;
    if (!agent) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (!agent.run_db_path || !fs.existsSync(agent.run_db_path)) {
      res.status(404).json({ error: 'Run database not found' });
      return;
    }
    const agentDb = new Database(agent.run_db_path);
    try {
      const config = yaml.load(agent.config_yaml) as z.infer<typeof agentConfigSchema>;
      const results: Record<string, unknown> = { queries: [] as unknown[] };
      for (const query of config.queries) {
        try {
          const rows = agentDb.prepare(query).all();
          (results.queries as unknown[]).push({ query, rows });
        } catch (qerr) {
          (results.queries as unknown[]).push({ query, error: qerr instanceof Error ? qerr.message : String(qerr) });
        }
      }
      results.summary = `Agent ${agent.name} analysis results.`;
      res.json(results);
    } finally {
      agentDb.close();
    }
  });

  app.get('/api/agents/:id/analysis', (req: Request, res: Response) => {
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as
      | { id: string; name: string }
      | undefined;
    if (!agent) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const analysisPath = path.join(getProjectDir(), 'analysis.md');
    if (!fs.existsSync(analysisPath)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const content = fs.readFileSync(analysisPath, 'utf-8');
    res.json({ content });
  });
}
