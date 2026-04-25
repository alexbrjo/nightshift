import { Express, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { getDb, getProjectDir } from './db';
import { validate } from './validation';
import { runSandboxedJS } from './sandbox';

export const actionConfigSchema = z.object({
  sourceCollection: z.string().min(1),
  scriptPath: z.string().min(1),
  targetCollection: z.string().min(1),
});

export async function executeActionScript(script: string, data: unknown): Promise<unknown> {
  return runSandboxedJS(script, { data });
}

export async function runAction(
  config: { sourceCollection: string; scriptPath: string; targetCollection: string },
  projectDir: string,
  limit?: number
) {
  const db = getDb();
  const script = fs.readFileSync(path.join(projectDir, config.scriptPath), 'utf-8');

  const sourceCol = db.prepare('SELECT id FROM collections WHERE name = ?').get(config.sourceCollection) as
    | { id: string }
    | undefined;
  if (!sourceCol) {
    throw new Error('Source collection not found');
  }

  let items = db
    .prepare('SELECT data_json FROM collection_items WHERE collection_id = ?')
    .all(sourceCol.id) as Array<{ data_json: string }>;

  if (limit !== undefined && limit > 0) {
    items = items.slice(0, limit);
  }

  let targetCol = db.prepare('SELECT id FROM collections WHERE name = ?').get(config.targetCollection) as
    | { id: string }
    | undefined;
  if (!targetCol) {
    targetCol = { id: uuidv4() };
    db.prepare('INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)').run(
      targetCol.id,
      config.targetCollection,
      Date.now()
    );
  } else {
    db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(targetCol.id);
  }

  for (const item of items) {
    const data = JSON.parse(item.data_json);
    const result = await executeActionScript(script, data);
    db.prepare('INSERT INTO collection_items (id, collection_id, data_json, created_at) VALUES (?, ?, ?, ?)').run(
      uuidv4(),
      targetCol.id,
      JSON.stringify(result),
      Date.now()
    );
  }
}

export function setupActionRoutes(app: Express) {
  app.post('/api/actions', (req: Request, res: Response) => {
    try {
      const config = validate(actionConfigSchema, req.body);
      const id = uuidv4();
      // Run in background so the request doesn't block
      runAction(config, getProjectDir()).catch((e) => console.error('Background action error:', e));
      res.json({ id });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Action failed' });
    }
  });
}
