import express from 'express';
import cors from 'cors';
import path from 'path';
import { initDb } from './db';
import { setupProjectRoutes } from './project';
import { setupJobRoutes } from './jobs';
import { setupCollectionRoutes } from './collections';
import { setupActionRoutes } from './actions';
import { setupPipelineRoutes } from './pipelines';
import { setupAgentRoutes } from './agents';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

initDb(PROJECT_DIR);

setupProjectRoutes(app);
setupJobRoutes(app);
setupCollectionRoutes(app);
setupActionRoutes(app);
setupPipelineRoutes(app);
setupAgentRoutes(app);

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../dist/client')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../dist/client/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Nightshift server running on http://localhost:${PORT}`);
});
