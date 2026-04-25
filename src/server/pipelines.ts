import { Express, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import nunjucks from 'nunjucks';
import fs from 'fs';
import path from 'path';
import { getDb, getProjectDir } from './db';
import { validate } from './validation';
import { runJob } from './jobs';
import { runAction } from './actions';
import { runAgent } from './agents';

export const pipelineConfigSchema = z.object({
  name: z.string().min(1),
  stages: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(['job', 'action', 'agent']),
      ref: z.string().min(1),
      config: z.record(z.unknown()).optional(),
    })
  ),
});

function renderStrings(obj: unknown, variables: Record<string, unknown>): unknown {
  if (typeof obj === 'string') {
    return nunjucks.renderString(obj, variables);
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => renderStrings(v, variables));
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = renderStrings(v, variables);
    }
    return out;
  }
  return obj;
}

export async function runPipeline(
  runId: string,
  pipelineId: string,
  variables: Record<string, unknown>,
  trial?: boolean
) {
  const db = getDb();
  const pipeline = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pipelineId) as
    | { definition_yaml: string }
    | undefined;
  if (!pipeline) {
    throw new Error('Pipeline not found');
  }

  const definition = yaml.load(pipeline.definition_yaml) as {
    stages: Array<{ id: string; type: 'job' | 'action' | 'agent'; ref: string; config?: Record<string, unknown> }>;
  };

  let currentInputCollection: string | undefined;
  const trialLimit = trial ? 3 : undefined;

  for (const stage of definition.stages) {
    const log = `Running stage ${stage.id} (${stage.type})`;
    db.prepare(`UPDATE pipeline_runs SET log = COALESCE(log, '') || ? WHERE id = ?`).run(log + '\n', runId);

    try {
      if (stage.type === 'job') {
        const jobRow = db.prepare('SELECT config_json FROM jobs WHERE id = ?').get(stage.ref) as
          | { config_json: string }
          | undefined;
        if (!jobRow) throw new Error(`Job ${stage.ref} not found`);
        let jobConfig = JSON.parse(jobRow.config_json);
        // Apply stage-level overrides and Jinja2 variable rendering
        if (stage.config) {
          jobConfig = { ...jobConfig, ...(renderStrings(stage.config, variables) as Record<string, unknown>) };
        }
        jobConfig = renderStrings(jobConfig, variables);
        if (currentInputCollection) {
          jobConfig.dataCollection = currentInputCollection;
          delete jobConfig.dataPath;
        }
        const jobId = uuidv4();
        const now = Date.now();
        const collectionName = `pipeline_${pipelineId}_${runId}_${stage.id}`;
        db.prepare(
          'INSERT INTO jobs (id, name, config_json, status, collection_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(jobId, `${stage.id}-${runId}`, JSON.stringify(jobConfig), 'pending', collectionName, now, now);
        await runJob(jobId, getProjectDir(), trialLimit);
        currentInputCollection = collectionName;
      } else if (stage.type === 'action') {
        let actionConfig = {
          sourceCollection: currentInputCollection || '',
          scriptPath: stage.ref,
          targetCollection: `pipeline_${pipelineId}_${runId}_${stage.id}`,
        };
        if (stage.config) {
          actionConfig = { ...actionConfig, ...(renderStrings(stage.config, variables) as Record<string, unknown>) } as typeof actionConfig;
        }
        actionConfig = renderStrings(actionConfig, variables) as typeof actionConfig;
        await runAction(actionConfig, getProjectDir(), trialLimit);
        currentInputCollection = actionConfig.targetCollection;
      } else if (stage.type === 'agent') {
        const agentRow = db.prepare('SELECT config_yaml FROM agents WHERE id = ?').get(stage.ref) as
          | { config_yaml: string }
          | undefined;
        if (!agentRow) throw new Error(`Agent ${stage.ref} not found`);
        let agentConfig = yaml.load(agentRow.config_yaml) as { queries: string[]; targetCollection?: string };
        if (stage.config) {
          agentConfig = { ...agentConfig, ...(renderStrings(stage.config, variables) as Record<string, unknown>) } as typeof agentConfig;
        }
        agentConfig = renderStrings(agentConfig, variables) as typeof agentConfig;
        await runAgent(stage.ref, getProjectDir(), agentConfig as any);
      }
    } catch (err) {
      const errMsg = `Stage ${stage.id} failed: ${err instanceof Error ? err.message : String(err)}\n`;
      db.prepare(`UPDATE pipeline_runs SET status = ?, log = COALESCE(log, '') || ? WHERE id = ?`).run(
        'error',
        errMsg,
        runId
      );
      return;
    }
  }

  db.prepare('UPDATE pipeline_runs SET status = ?, completed_at = ? WHERE id = ?').run(
    'completed',
    Date.now(),
    runId
  );
}

export function setupPipelineRoutes(app: Express) {
  app.get('/api/pipelines', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM pipelines ORDER BY created_at DESC').all() as Array<{
      id: string;
      name: string;
      definition_yaml: string;
      status: string;
      created_at: number;
    }>;
    const pipelines = rows.map((r) => {
      const runs = db
        .prepare('SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC')
        .all(r.id) as Array<{
          id: string;
          pipeline_id: string;
          status: string;
          started_at: number | null;
          completed_at: number | null;
          log: string | null;
        }>;
      return {
        ...r,
        definition: yaml.load(r.definition_yaml) as object,
        stages: (yaml.load(r.definition_yaml) as { stages: unknown[] }).stages,
        createdAt: new Date(r.created_at).toISOString(),
        runs: runs.map((run) => ({
          ...run,
          startedAt: run.started_at ? new Date(run.started_at).toISOString() : null,
          completedAt: run.completed_at ? new Date(run.completed_at).toISOString() : null,
        })),
      };
    });
    res.json({ pipelines });
  });

  app.get('/api/pipelines/:id', (req: Request, res: Response) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id) as
      | { id: string; name: string; definition_yaml: string; status: string; created_at: number }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const runs = db
      .prepare('SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC')
      .all(req.params.id) as Array<{
        id: string;
        pipeline_id: string;
        status: string;
        started_at: number | null;
        completed_at: number | null;
        log: string | null;
      }>;
    res.json({
      pipeline: {
        ...row,
        definition: yaml.load(row.definition_yaml) as object,
        stages: (yaml.load(row.definition_yaml) as { stages: unknown[] }).stages,
        createdAt: new Date(row.created_at).toISOString(),
        runs: runs.map((run) => ({
          ...run,
          startedAt: run.started_at ? new Date(run.started_at).toISOString() : null,
          completedAt: run.completed_at ? new Date(run.completed_at).toISOString() : null,
        })),
      },
    });
  });

  app.post('/api/pipelines', (req: Request, res: Response) => {
    const db = getDb();
    const config = validate(pipelineConfigSchema, req.body);
    const id = uuidv4();
    const now = Date.now();
    db.prepare('INSERT INTO pipelines (id, name, definition_yaml, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      config.name,
      yaml.dump(config),
      'draft',
      now
    );
    // Persist pipeline definition to YAML file in project dir
    const pipelinesDir = path.join(getProjectDir(), 'pipelines');
    if (!fs.existsSync(pipelinesDir)) {
      fs.mkdirSync(pipelinesDir, { recursive: true });
    }
    fs.writeFileSync(path.join(pipelinesDir, `${config.name}.yaml`), yaml.dump(config), 'utf-8');
    res.json({ id });
  });

  app.post('/api/pipelines/:id/run', (req: Request, res: Response) => {
    const db = getDb();
    const pipeline = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id) as
      | { id: string }
      | undefined;
    if (!pipeline) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const runId = uuidv4();
    const now = Date.now();
    db.prepare('INSERT INTO pipeline_runs (id, pipeline_id, status, started_at) VALUES (?, ?, ?, ?)').run(
      runId,
      req.params.id,
      'running',
      now
    );
    const variables = (req.body.variables as Record<string, unknown>) || {};
    const trial = req.body.trial === true;
    runPipeline(runId, req.params.id, variables, trial).catch((e) => {
      console.error('Pipeline run error:', e);
      db.prepare('UPDATE pipeline_runs SET status = ? WHERE id = ?').run('error', runId);
    });
    res.json({ runId });
  });
}
