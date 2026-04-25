import { z } from 'zod';

export const JobConfigSchema = z.object({
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
  maxTokens: z.number().int().min(1),
  thinkingBudget: z.number().int().optional(),
  preRenderUrl: z.string().optional(),
  preRenderJson: z.string().optional(),
});

export const ActionConfigSchema = z.object({
  sourceCollection: z.string().min(1),
  scriptPath: z.string().min(1),
  targetCollection: z.string().min(1),
});

export const PipelineStageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['job', 'action', 'agent']),
  ref: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

export const PipelineSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  stages: z.array(PipelineStageSchema).min(1),
});

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  pipelineId: z.string().optional(),
  queries: z.array(z.string()).min(1),
  targetCollection: z.string().optional(),
});

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}
