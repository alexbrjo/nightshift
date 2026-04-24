import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import yaml from 'js-yaml'
import type { DbConnection } from '../db/database'
import {
  createPipelineRun,
} from '../db/database'
import { InferenceEngine } from './engine'
import { BulkActionExecutor } from './bulkActionExecutor'

// ─── Pipeline stage executor ───────────────────────────────────────────

interface StageExecutionResult {
  stageId: string
  status: 'pending' | 'running' | 'completed' | 'errored'
  inputCount: number
  outputCount: number
  startedAt: number
  completedAt?: number
  error?: string
}

export class PipelineOrchestrator {
  private db: DbConnection['db']
  private inferenceEngine: InferenceEngine
  private bulkActionExecutor: BulkActionExecutor

  constructor(db: DbConnection['db']) {
    this.db = db
    this.inferenceEngine = new InferenceEngine(db)
    this.bulkActionExecutor = new BulkActionExecutor(db)
  }

  async runPipeline(
    pipelineId: string,
    projectId: string,
    projectPath: string,
    groupId?: string
  ): Promise<string> {
    const runId = createPipelineRun(this.db, pipelineId, groupId)

    // Fetch pipeline stages
    const stages = this.db.prepare(
      'SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY order_num'
    ).all(pipelineId) as Record<string, unknown>[]

    let currentInput: Record<string, unknown>[] | undefined

    for (const stage of stages) {
      const result: StageExecutionResult = {
        stageId: stage.id as string,
        status: 'running',
        inputCount: currentInput?.length ?? 0,
        outputCount: 0,
        startedAt: Date.now(),
      }

      try {
        switch (stage.stage_type) {
          case 'inference': {
            result.outputCount = await this.executeInferenceStage(
              stage as Record<string, unknown>,
              projectPath,
              currentInput
            )
            break
          }
          case 'javascript-action': {
            result.outputCount = await this.executeJsActionStage(
              stage as Record<string, unknown>,
              projectPath,
              currentInput
            )
            break
          }
          case 'analysis-agent': {
            result.outputCount = await this.executeAgentStage(
              stage as Record<string, unknown>,
              projectId,
              projectPath,
              currentInput
            )
            break
          }
        }

        result.status = 'completed'
      } catch (err) {
        result.status = 'errored'
        result.error = err instanceof Error ? err.message : String(err)
      } finally {
        result.completedAt = Date.now()
        this.saveStageResult(runId, result)

        // Update pipeline run status when all stages complete
        const allStages = this.db.prepare(
          "SELECT id FROM pipeline_stages WHERE pipeline_id = ?"
        ).all(pipelineId) as { id: string }[]

        const completedCount = this.db.prepare(
          `SELECT COUNT(*) as count FROM pipeline_stage_results WHERE run_id = ? AND status = 'completed'`
        ).get(runId) as { count: number } | undefined

        if (completedCount && allStages.length > 0 && completedCount.count >= allStages.length) {
          this.db.prepare('UPDATE pipeline_runs SET status = ?, completed_at = ? WHERE id = ?').run(
            result.status === 'errored' ? 'errored' : 'completed',
            Date.now(),
            runId
          )
        }
      }

      // If stage errored, stop the pipeline
      if (result.status === 'errored') {
        break
      }
    }

    return runId
  }

  async executeTrialRun(
    pipelineId: string,
    projectId: string,
    projectPath: string,
    trialSize: number = 3
  ): Promise<string> {
    const runId = createPipelineRun(this.db, pipelineId)

    const stages = this.db.prepare(
      'SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY order_num'
    ).all(pipelineId) as Record<string, unknown>[]

    let currentInput: Record<string, unknown>[] | undefined

    for (const stage of stages) {
      const result: StageExecutionResult = {
        stageId: stage.id as string,
        status: 'running',
        inputCount: currentInput?.length ?? 0,
        outputCount: 0,
        startedAt: Date.now(),
      }

      try {
        switch (stage.stage_type) {
          case 'inference': {
            result.outputCount = await this.executeInferenceStage(
              stage as Record<string, unknown>,
              projectPath,
              currentInput,
              trialSize
            )
            break
          }
          case 'javascript-action': {
            const limitedInput = currentInput?.slice(0, trialSize) ?? []
            result.outputCount = await this.executeJsActionStage(
              stage as Record<string, unknown>,
              projectPath,
              limitedInput
            )
            break
          }
          case 'analysis-agent': {
            const limitedInput = currentInput?.slice(0, trialSize) ?? []
            result.outputCount = await this.executeAgentStage(
              stage as Record<string, unknown>,
              projectId,
              projectPath,
              limitedInput
            )
            break
          }
        }

        result.status = 'completed'
      } catch (err) {
        result.status = 'errored'
        result.error = err instanceof Error ? err.message : String(err)
      } finally {
        result.completedAt = Date.now()
        this.saveStageResult(runId, result)
      }

      if (result.status === 'errored') break
    }

    // Mark trial run as completed
    this.db.prepare('UPDATE pipeline_runs SET status = ?, completed_at = ? WHERE id = ?').run(
      'completed',
      Date.now(),
      runId
    )

    return runId
  }

  exportPipelineToYaml(pipelineId: string): string {
    const pipeline = this.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pipelineId) as Record<string, unknown> | undefined
    if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`)

    const stages = this.db.prepare(
      'SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY order_num'
    ).all(pipelineId) as Record<string, unknown>[]

    const yamlData = {
      name: pipeline.name as string,
      stages: stages.map(stage => ({
        name: stage.name as string,
        type: stage.stage_type as string,
        job_id: stage.job_id,
        action_id: stage.action_id,
        agent_config_id: stage.agent_config_id,
        input_mapping: stage.input_mapping ? JSON.parse(stage.input_mapping as string) : {},
        output_collection: stage.output_collection,
      })),
    }

    return yaml.dump(yamlData, { lineWidth: -1, noRefs: true }) as string
  }

  private async executeInferenceStage(
    stage: Record<string, unknown>,
    projectPath: string,
    input?: Record<string, unknown>[],
    maxSamples?: number
  ): Promise<number> {
    const jobId = stage.job_id as string | undefined
    if (!jobId) throw new Error('Inference stage missing job_id')

    // If there's input from previous stage, update the job config to use it
    if (input && input.length > 0) {
      const tempPath = join(projectPath, '.nightshift', `pipeline_${stage.id}_input.json`)
      writeFileSync(tempPath, JSON.stringify(input, null, 2))

      this.db.prepare('UPDATE inference_jobs SET source_data_path = ?, num_samples = ? WHERE id = ?').run(
        `.nightshift/pipeline_${stage.id}_input.json`,
        maxSamples ?? input.length,
        jobId
      )
    }

    const engine = new InferenceEngine(this.db)
    await engine.runJob(jobId, projectPath)

    return input?.length ?? 0
  }

  private async executeJsActionStage(
    stage: Record<string, unknown>,
    projectPath: string,
    input?: Record<string, unknown>[]
  ): Promise<number> {
    const actionId = stage.action_id as string | undefined
    if (!actionId) throw new Error('JS Action stage missing action_id')

    const actionRow = this.db.prepare('SELECT * FROM bulk_actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined
    if (!actionRow) throw new Error(`Bulk action not found: ${actionId}`)

    const executor = new BulkActionExecutor(this.db)
    const result = await executor.execute(
      actionId,
      projectPath,
      actionRow.source_collection as string,
      actionRow.target_collection as string,
      join(projectPath, actionRow.script_file as string),
      input?.length ?? 100
    )

    return result.successCount
  }

  private async executeAgentStage(
    stage: Record<string, unknown>,
    projectId: string,
    projectPath: string,
    input?: Record<string, unknown>[]
  ): Promise<number> {
    const agentConfigId = stage.agent_config_id as string | undefined
    if (!agentConfigId) throw new Error('Agent stage missing agent_config_id')

    // Create a per-run isolated database (copy-on-create model)
    const runDbPath = join(projectPath, '.nightshift', `agent_run_${stage.id}_${Date.now()}.db`)

    // Clone relevant tables into the isolated DB
    this.cloneTablesForAgentRun(runDbPath, input)

    // The agent would execute here using the isolated DB
    // For now, we just record the run
    const { createAgentRun } = await import('../db/database')
    const runId = createAgentRun(this.db, agentConfigId, runDbPath)

    return input?.length ?? 0
  }

  private cloneTablesForAgentRun(runDbPath: string, inputData?: Record<string, unknown>[]): void {
    // Create isolated DB for the agent
    const { initProjectDb, closeDb } = require('../db/database')
    const runDb = initProjectDb(join(projectPathFromDbPath(runDbPath)))

    // Clone schemas and input data into the per-run database
    if (inputData && inputData.length > 0) {
      for (const item of inputData.slice(0, 100)) {
        runDb.prepare(
          `INSERT INTO agent_input_data (id, data, created_at) VALUES (?, ?, ?)`
        ).run(uuidv4(), JSON.stringify(item), Date.now())
      }
    }

    closeDb(runDb)
  }

  private saveStageResult(runId: string, result: StageExecutionResult): void {
    this.db.prepare(
      `INSERT INTO pipeline_stage_results (id, run_id, stage_id, status, input_count, output_count, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), runId, result.stageId, result.status, result.inputCount, result.outputCount, result.startedAt, result.completedAt ?? null, result.error ?? null)
  }
}

function projectPathFromDbPath(runDbPath: string): string {
  // Extract the project path from a DB file path like /project/.nightshift/agent_run_xxx.db
  const parts = runDbPath.split('/')
  // Find .nightshift and return everything before it
  const idx = parts.indexOf('.nightshift')
  if (idx > 0) {
    return parts.slice(0, idx).join('/')
  }
  return parts.slice(0, -1).join('/')
}
