import { Express, Request, Response } from 'express';
import Papa from 'papaparse';
import { getDb } from './db';

export function setupCollectionRoutes(app: Express) {
  app.get('/api/collections', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM collections ORDER BY created_at DESC').all() as Array<{
      id: string;
      name: string;
      schema_json: string | null;
      created_at: number;
    }>;
    res.json({
      collections: rows.map((r) => ({
        ...r,
        schema: r.schema_json ? JSON.parse(r.schema_json) : undefined,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  });

  app.get('/api/collections/:name', (req: Request, res: Response) => {
    const db = getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const search = String(req.query.search || '');
    const collection = db.prepare('SELECT * FROM collections WHERE name = ?').get(req.params.name) as
      | { id: string; name: string; schema_json: string | null; created_at: number }
      | undefined;
    if (!collection) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const limit = 50;
    const offset = (page - 1) * limit;
    let whereClause = 'collection_id = ?';
    const params: unknown[] = [collection.id];
    if (search) {
      whereClause += ' AND data_json LIKE ?';
      params.push(`%${search}%`);
    }
    const items = db
      .prepare(`SELECT * FROM collection_items WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{
        id: string;
        collection_id: string;
        data_json: string;
        created_at: number;
      }>;
    const totalRow = db
      .prepare(`SELECT COUNT(*) as total FROM collection_items WHERE ${whereClause}`)
      .get(...params) as { total: number };

    const columns = new Set<string>();
    for (const item of items) {
      const data = JSON.parse(item.data_json) as Record<string, unknown>;
      Object.keys(data).forEach((k) => columns.add(k));
    }

    res.json({
      items: items.map((i) => ({
        ...i,
        data: JSON.parse(i.data_json),
        createdAt: new Date(i.created_at).toISOString(),
      })),
      total: totalRow.total,
      columns: Array.from(columns),
    });
  });

  app.delete('/api/collections/:name/items/:id', (req: Request, res: Response) => {
    const db = getDb();
    const collection = db.prepare('SELECT id FROM collections WHERE name = ?').get(req.params.name) as
      | { id: string }
      | undefined;
    if (!collection) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    db.prepare('DELETE FROM collection_items WHERE id = ? AND collection_id = ?').run(req.params.id, collection.id);
    res.json({ success: true });
  });

  app.get('/api/collections/:name/export', (req: Request, res: Response) => {
    const db = getDb();
    const format = req.query.format === 'csv' ? 'csv' : 'jsonl';
    const collection = db.prepare('SELECT id FROM collections WHERE name = ?').get(req.params.name) as
      | { id: string }
      | undefined;
    if (!collection) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const items = db
      .prepare('SELECT data_json FROM collection_items WHERE collection_id = ? ORDER BY created_at DESC')
      .all(collection.id) as Array<{ data_json: string }>;

    if (format === 'jsonl') {
      const lines = items.map((i) => i.data_json).join('\n');
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.jsonl"`);
      res.send(lines);
    } else {
      const data = items.map((i) => JSON.parse(i.data_json));
      const csv = Papa.unparse(data);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.csv"`);
      res.send(csv);
    }
  });
}
