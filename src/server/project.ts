import { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { initDb, getProjectDir } from './db';

export function setupProjectRoutes(app: Express) {
  app.get('/api/project/files', (req, res) => {
    const projectDir = getProjectDir();
    const dir = req.query.dir ? path.join(projectDir, String(req.query.dir)) : projectDir;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.map((e) => ({
      path: path.relative(projectDir, path.join(dir, e.name)),
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
    res.json({ files });
  });

  app.get('/api/project/file', (req, res) => {
    const filePath = path.join(getProjectDir(), String(req.query.path));
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content });
  });

  app.post('/api/project/file', (req, res) => {
    const { path: relPath, content } = req.body;
    const filePath = path.join(getProjectDir(), relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true });
  });

  app.delete('/api/project/file', (req, res) => {
    const filePath = path.join(getProjectDir(), String(req.query.path));
    fs.unlinkSync(filePath);
    res.json({ success: true });
  });

  app.get('/api/project', (_req, res) => {
    try {
      res.json({ path: getProjectDir() });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
    }
  });

  app.post('/api/project/open', (req, res) => {
    const { path: newPath } = req.body;
    if (!newPath || typeof newPath !== 'string') {
      res.status(400).json({ error: 'Path is required' });
      return;
    }
    const resolved = path.resolve(newPath);
    if (!fs.existsSync(resolved)) {
      res.status(400).json({ error: 'Path does not exist' });
      return;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' });
      return;
    }
    initDb(resolved);
    res.json({ path: resolved });
  });
}
