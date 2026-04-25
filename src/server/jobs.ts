import { Express, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import axios from 'axios';
import Papa from 'papaparse';
import nunjucks from 'nunjucks';
import fs from 'fs';
import path from 'path';
import { getDb, getProjectDir } from './db';
import { validate } from './validation';
import { jobEvents, emitSampleUpdate, emitJobUpdate } from './events';

export const jobConfigSchema = z.object({
  name: z.string().min(1),
  samples: z.number().int().min(1),
  strategy: z.enum(['single', 'random', 'exhaustive']),
  templatePath: z.string().min(1),
  dataPath: z.string().optional(),
  dataCollection: z.string().optional(),
  host: z.string().min(1),
  model: z.string().min(1),
  outputMode: z.enum(['unstructured', 'json', 'schema']),
  schemaPath: z.string().optional(),
  temperature: z.number(),
  maxTokens: z.number().int(),
  thinkingBudget: z.number().int().optional(),
  preRenderUrl: z.string().optional(),
  preRenderJson: z.string().optional(),
});

export function parseData(filePath: string): unknown[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (ext === '.jsonl') {
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
  if (ext === '.csv') {
    const results = Papa.parse(content, { header: true, skipEmptyLines: true });
    return (results.data as unknown[]) || [];
  }
  throw new Error(`Unsupported data format: ${ext}`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callLLM(
  host: string,
  model: string,
  prompt: string,
  temperature: number,
  maxTokens: number
): Promise<string> {
  const url = host.endsWith('/v1/chat/completions')
    ? host
    : host.endsWith('/v1')
    ? `${host}/chat/completions`
    : `${host}/v1/chat/completions`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.post(
        url,
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000,
          maxContentLength: 10 * 1024 * 1024,
          maxBodyLength: 10 * 1024 * 1024,
        }
      );
      return res.data.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        lastErr = err;
        await delay(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('LLM call failed after retries');
}

function estimateTokens(text: string): number {
  // Very rough estimate: 1 token ≈ 4 chars for English
  return Math.ceil(text.length / 4);
}

export async function runJob(jobId: string, projectDir: string, trialLimit?: number) {
  const db = getDb();
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('running', jobId);
  emitJobUpdate(jobId, 'running');

  const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
    | { config_json: string; collection_name: string }
    | undefined;
  if (!jobRow) {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('error', jobId);
    emitJobUpdate(jobId, 'error');
    return;
  }

  const config = JSON.parse(jobRow.config_json) as z.infer<typeof jobConfigSchema>;

  try {
    // Read and pre-compile template (fail fast on syntax errors)
    const templatePath = path.join(getProjectDir(), config.templatePath);
    const templateSrc = fs.readFileSync(templatePath, 'utf-8');
    let compiledTemplate: ReturnType<typeof nunjucks.compile>;
    try {
      compiledTemplate = nunjucks.compile(templateSrc);
    } catch (compileErr) {
      const msg = compileErr instanceof Error ? compileErr.message : String(compileErr);
      throw new Error(`Template syntax error in ${config.templatePath}: ${msg}`);
    }

    // Read data
    let rows: unknown[] = [];
    if (config.dataCollection) {
      const col = db.prepare('SELECT id FROM collections WHERE name = ?').get(config.dataCollection) as
        | { id: string }
        | undefined;
      if (col) {
        const items = db
          .prepare('SELECT data_json FROM collection_items WHERE collection_id = ?')
          .all(col.id) as Array<{ data_json: string }>;
        rows = items.map((i) => JSON.parse(i.data_json));
      }
    } else if (config.dataPath) {
      rows = parseData(path.join(getProjectDir(), config.dataPath));
    }

    // Sampling strategy
    if (config.strategy === 'single') {
      rows = rows.slice(0, 1);
    } else if (config.strategy === 'random') {
      const n = Math.min(config.samples, rows.length);
      rows = shuffle(rows).slice(0, n);
    }
    // exhaustive uses all rows

    if (trialLimit !== undefined) {
      rows = rows.slice(0, trialLimit);
    }

    // Ensure output collection exists
    let collection = db.prepare('SELECT id FROM collections WHERE name = ?').get(jobRow.collection_name) as
      | { id: string }
      | undefined;
    if (!collection) {
      const colId = uuidv4();
      db.prepare('INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)').run(colId, jobRow.collection_name, Date.now());
      collection = { id: colId };
    }

    // Schema keys
    let schemaKeys: string[] | null = null;
    if (config.schemaPath) {
      const schemaContent = fs.readFileSync(path.join(getProjectDir(), config.schemaPath), 'utf-8');
      schemaKeys = Object.keys(JSON.parse(schemaContent));
    }

    // Process in batches of 5
    const concurrency = 5;
    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (row) => {
          const sampleId = uuidv4();
          let prompt: string;
          try {
            prompt = compiledTemplate.render(row as Record<string, unknown>);
          } catch (renderErr) {
            const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
            db.prepare('INSERT INTO samples (id, job_id, status, prompt, error, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
              sampleId,
              jobId,
              'error',
              '',
              `Template render error: ${msg}`,
              Date.now()
            );
            emitSampleUpdate(jobId, sampleId, 'error', { error: msg });
            return;
          }
          db.prepare('INSERT INTO samples (id, job_id, status, prompt, created_at) VALUES (?, ?, ?, ?, ?)').run(
            sampleId,
            jobId,
            'streaming',
            prompt,
            Date.now()
          );
          emitSampleUpdate(jobId, sampleId, 'streaming');

          let finalPrompt = prompt;
          if (config.preRenderUrl) {
            try {
              const preBody = config.preRenderJson ? JSON.parse(config.preRenderJson) : {};
              const preRes = await axios.post(config.preRenderUrl, preBody, {
                timeout: 10000,
                maxContentLength: 1024 * 1024,
                maxBodyLength: 1024 * 1024,
              });
              finalPrompt = `Context: ${JSON.stringify(preRes.data)}\n\nPrompt: ${prompt}`;
            } catch (e) {
              // ignore pre-render failure silently
            }
          }

          const start = Date.now();
          let responseText = '';
          let errorMsg: string | null = null;
          let parsed: unknown | null = null;
          try {
            responseText = await callLLM(config.host, config.model, finalPrompt, config.temperature, config.maxTokens);
            const latency = Date.now() - start;
            const tokens = estimateTokens(responseText);

            if (config.outputMode === 'json' || config.outputMode === 'schema') {
              try {
                parsed = JSON.parse(responseText);
                if (config.outputMode === 'schema' && schemaKeys) {
                  const missing = schemaKeys.filter((k) => !(k in (parsed as Record<string, unknown>)));
                  if (missing.length > 0) {
                    throw new Error(`Missing schema keys: ${missing.join(', ')}`);
                  }
                }
              } catch (parseErr) {
                errorMsg = parseErr instanceof Error ? parseErr.message : 'JSON parse error';
                parsed = null;
              }
            }

            db.prepare(
              'UPDATE samples SET status = ?, response = ?, parsed = ?, error = ?, latency_ms = ?, tokens = ? WHERE id = ?'
            ).run(
              errorMsg ? 'error' : 'completed',
              responseText,
              parsed ? JSON.stringify(parsed) : null,
              errorMsg,
              latency,
              tokens,
              sampleId
            );
            emitSampleUpdate(jobId, sampleId, errorMsg ? 'error' : 'completed', {
              response: responseText,
              parsed,
              error: errorMsg,
              latencyMs: latency,
              tokens,
            });

            const data = parsed ? parsed : { response: responseText };
            db.prepare('INSERT INTO collection_items (id, collection_id, data_json, created_at) VALUES (?, ?, ?, ?)').run(
              uuidv4(),
              collection!.id,
              JSON.stringify(data),
              Date.now()
            );
          } catch (llmErr) {
            const latency = Date.now() - start;
            errorMsg = llmErr instanceof Error ? llmErr.message : 'LLM error';
            db.prepare('UPDATE samples SET status = ?, error = ?, latency_ms = ? WHERE id = ?').run(
              'error',
              errorMsg,
              latency,
              sampleId
            );
            emitSampleUpdate(jobId, sampleId, 'error', { error: errorMsg, latencyMs: latency });
          }
        })
      );
    }

    // Update collection schema
    const items = db.prepare('SELECT data_json FROM collection_items WHERE collection_id = ? LIMIT 100').all(collection!.id) as Array<{
      data_json: string;
    }>;
    const columns = new Set<string>();
    for (const item of items) {
      const d = JSON.parse(item.data_json);
      if (typeof d === 'object' && d !== null) {
        Object.keys(d).forEach((k) => columns.add(k));
      }
    }
    db.prepare('UPDATE collections SET schema_json = ? WHERE id = ?').run(
      JSON.stringify(Array.from(columns)),
      collection!.id
    );

    db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run('completed', Date.now(), jobId);
    emitJobUpdate(jobId, 'completed');
  } catch (runnerErr) {
    const msg = runnerErr instanceof Error ? runnerErr.message : String(runnerErr);
    db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run('error', Date.now(), jobId);
    emitJobUpdate(jobId, 'error');
    // eslint-disable-next-line no-console
    console.error('Job runner error:', msg);
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function setupJobRoutes(app: Express) {
  app.get('/api/jobs', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as Array<{
      id: string;
      name: string;
      config_json: string;
      status: string;
      collection_name: string;
      created_at: number;
      updated_at: number;
    }>;
    res.json({
      jobs: rows.map((r) => ({
        ...r,
        config: JSON.parse(r.config_json),
        collectionName: r.collection_name,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    });
  });

  app.post('/api/jobs', (req: Request, res: Response) => {
    const db = getDb();
    const config = validate(jobConfigSchema, req.body);
    const id = uuidv4();
    const now = Date.now();
    const collectionName = `job_${id}`;
    db.prepare(
      'INSERT INTO jobs (id, name, config_json, status, collection_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, config.name, JSON.stringify(config), 'pending', collectionName, now, now);
    // Spawn runner in background
    runJob(id, getProjectDir()).catch((e) => console.error('Background job error:', e));
    res.json({ id });
  });

  app.get('/api/jobs/:id', (req: Request, res: Response) => {
    const db = getDb();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id) as
      | { id: string; name: string; config_json: string; status: string; collection_name: string; created_at: number; updated_at: number }
      | undefined;
    if (!job) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const samples = db.prepare('SELECT * FROM samples WHERE job_id = ? ORDER BY created_at DESC').all(req.params.id) as Array<{
      id: string;
      job_id: string;
      status: string;
      prompt: string;
      response: string | null;
      parsed: string | null;
      error: string | null;
      latency_ms: number | null;
      tokens: number | null;
      created_at: number;
    }>;
    res.json({
      job: {
        ...job,
        config: JSON.parse(job.config_json),
        collectionName: job.collection_name,
        createdAt: new Date(job.created_at).toISOString(),
        updatedAt: new Date(job.updated_at).toISOString(),
      },
      samples: samples.map((s) => ({
        ...s,
        jobId: s.job_id,
        latencyMs: s.latency_ms,
        createdAt: new Date(s.created_at).toISOString(),
      })),
    });
  });

  app.get('/api/jobs/:id/yaml', (req: Request, res: Response) => {
    const db = getDb();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id) as
      | { config_json: string }
      | undefined;
    if (!job) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const config = JSON.parse(job.config_json);
    res.setHeader('Content-Type', 'text/yaml');
    res.send(yaml.dump(config));
  });

  app.get('/api/jobs/:id/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const db = getDb();
    const samples = db
      .prepare('SELECT * FROM samples WHERE job_id = ? ORDER BY created_at DESC')
      .all(req.params.id) as Array<{
        id: string;
        job_id: string;
        status: string;
        prompt: string;
        response: string | null;
        parsed: string | null;
        error: string | null;
        latency_ms: number | null;
        tokens: number | null;
        created_at: number;
      }>;
    res.write(
      `data: ${JSON.stringify({
        type: 'init',
        samples: samples.map((s) => ({
          ...s,
          jobId: s.job_id,
          latencyMs: s.latency_ms,
          createdAt: new Date(s.created_at).toISOString(),
        })),
      })}
\n\n`
    );

    const listener = (data: { jobId: string; sampleId: string; status: string; payload?: Record<string, unknown> }) => {
      if (data.jobId === req.params.id) {
        res.write(`data: ${JSON.stringify({ type: 'update', ...data })}\n\n`);
      }
    };
    jobEvents.on('sample', listener);
    req.on('close', () => jobEvents.off('sample', listener));
  });
}
