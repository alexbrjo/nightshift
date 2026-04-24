import { ipcMain, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import yaml from 'js-yaml'
import type { DbConnection } from './db/database'
import {
  initProjectDb,
  closeDb,
  getProjectByPath,
  createProject,
  updateProject,
  createInferenceJob,
  updateJobStatus,
  createBulkAction,
  createPipeline,
  addPipelineStage,
  createAnalysisAgentConfig,
  getAllCollectionNames,
} from './db/database'
import {
  readProjectFile,
  writeProjectFile,
  deleteProjectFile,
  listDirectory,
  getProjectName,
  findFilesByExtension,
  getFileLanguage,
} from './filesystem/fileService'
import { InferenceEngine } from './inference/engine'
import { BulkActionExecutor } from './inference/bulkActionExecutor'
import { PipelineOrchestrator } from './inference/pipelineOrchestrator'
import { exportToYaml, importFromYaml } from '@shared/utils'

// ─── Project state management ──────────────────────────────────────────

const projectDbs = new Map<string, DbConnection>()

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // ─── File System IPC Handlers ───────────────────────────────────────

  ipcMain.handle('fs:list-directory', async (_event, projectPath: string, relativePath: string) => {
    return listDirectory(projectPath, relativePath)
  })

  ipcMain.handle('fs:read-file', async (_event, projectPath: string, relativePath: string) => {
    return readProjectFile(projectPath, relativePath)
  })

  ipcMain.handle('fs:write-file', async (_event, projectPath: string, relativePath: string, content: string) => {
    writeProjectFile(projectPath, relativePath, content)
    return true
  })

  ipcMain.handle('fs:delete-file', async (_event, projectPath: string, relativePath: string) => {
    deleteProjectFile(projectPath, relativePath)
    return true
  })

  ipcMain.handle('fs:get-language', async (_event, filename: string) => {
    const ext = filename.split('.').pop() ?? ''
    return getFileLanguage(ext)
  })

  ipcMain.handle('fs:find-files', async (_event, projectPath: string, extensions: string[]) => {
    return findFilesByExtension(projectPath, extensions)
  })

  // ─── Project IPC Handlers ──────────────────────────────────────────

  ipcMain.handle('project:open', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Open Project Folder',
    })

    if (result.canceled || result.filePaths.length === 0) return null

    const projectPath = result.filePaths[0]
    let db = projectDbs.get(projectPath)

    if (!db) {
      db = initProjectDb(projectPath)
      projectDbs.set(projectPath, db)
    }

    // Get or create project record
    let projectId = getProjectByPath(db.db, projectPath)?.id as string | undefined
    if (!projectId) {
      projectId = createProject(db.db, projectPath, getProjectName(projectPath))
    } else {
      updateProject(db.db, projectId)
    }

    return { id: projectId, path: projectPath, name: getProjectName(projectPath) }
  })

  ipcMain.handle('project:get-db', (_event, projectPath: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    return { projectPath } // Return path, renderer doesn't get direct DB access
  })

  ipcMain.handle('project:get-collections', (_event, projectPath: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    return getAllCollectionNames(db.db)
  })

  // ─── Inference Job IPC Handlers ─────────────────────────────────────

  ipcMain.handle('job:create', async (_event, projectPath: string, config: Record<string, unknown>) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    // Get or create project record
    let projectId = getProjectByPath(db.db, projectPath)?.id as string | undefined
    if (!projectId) {
      projectId = createProject(db.db, projectPath, getProjectName(projectPath))
    }

    const jobId = createInferenceJob(db.db, { ...config, projectId })

    // Start job execution in background
    const engine = new InferenceEngine(db.db)
    engine.runJob(jobId, projectPath).catch(err => {
      console.error(`[IPC] Job ${jobId} failed:`, err)
      updateJobStatus(db.db, jobId, 'errored')
    })

    return jobId
  })

  ipcMain.handle('job:get-results', (_event, projectPath: string, jobId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    return db.db.prepare('SELECT * FROM job_sample_results WHERE job_id = ? ORDER BY sample_index').all(jobId)
  })

  ipcMain.handle('job:get-status', (_event, projectPath: string, jobId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    return db.db.prepare("SELECT id, name, status, total_samples, completed_samples, errored_samples FROM inference_jobs WHERE id = ?").get(jobId)
  })

  ipcMain.handle('job:update-status', (_event, projectPath: string, jobId: string, status: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    updateJobStatus(db.db, jobId, status)
  })

  ipcMain.handle('job:export-yaml', (_event, projectPath: string, jobId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    const job = db.db.prepare('SELECT * FROM inference_jobs WHERE id = ?').get(jobId) as Record<string, unknown>
    if (!job) throw new Error(`Job not found: ${jobId}`)

    const yamlData = {
      name: job.name,
      sampling_strategy: job.sampling_strategy,
      num_samples: job.num_samples,
      template_file: job.template_file,
      source_data_type: job.source_data_type,
      source_data_path: job.source_data_path,
      api_endpoint: job.api_endpoint,
      model_name: job.model_name,
      output_mode: job.output_mode,
      temperature: job.temperature,
      max_tokens: job.max_tokens,
      thinking_budget: job.thinking_budget,
    }

    return exportToYaml(yamlData)
  })

  // ─── Collection IPC Handlers ────────────────────────────────────────

  ipcMain.handle('collection:get-items', (_event, projectPath: string, collectionName: string, page: number = 1, pageSize: number = 50) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    // Import the helper functions from database module
    const { getCollectionItems } = require('./db/database')
    return getCollectionItems(db.db, collectionName, page, pageSize)
  })

  ipcMain.handle('collection:search', (_event, projectPath: string, collectionName: string, query: string, page: number = 1, pageSize: number = 50) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    const { searchCollectionItems } = require('./db/database')
    return searchCollectionItems(db.db, collectionName, query, page, pageSize)
  })

  ipcMain.handle('collection:delete-item', (_event, projectPath: string, collectionName: string, itemId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    const { deleteCollectionItem } = require('./db/database')
    deleteCollectionItem(db.db, collectionName, itemId)
  })

  ipcMain.handle('collection:export-jsonl', (_event, projectPath: string, collectionName: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    const { getCollectionItems } = require('./db/database')

    // Export all items (paginated)
    let page = 1
    let allItems: Record<string, unknown>[] = []
    while (true) {
      const result = getCollectionItems(db.db, collectionName, page, 50)
      allItems = [...allItems, ...result.items]
      if (result.items.length < 50) break
      page++
    }

    return allItems.map(item => JSON.stringify(item)).join('\n')
  })

  ipcMain.handle('collection:export-csv', (_event, projectPath: string, collectionName: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    const { getCollectionItems } = require('./db/database')

    let page = 1
    let allItems: Record<string, unknown>[] = []
    while (true) {
      const result = getCollectionItems(db.db, collectionName, page, 50)
      allItems = [...allItems, ...result.items]
      if (result.items.length < 50) break
      page++
    }

    if (allItems.length === 0) return ''

    // Flatten and detect columns
    const flattenKeys = (obj: Record<string, unknown>, prefix = ''): string[] => {
      const keys: string[] = []
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          keys.push(...flattenKeys(value as Record<string, unknown>, fullKey))
        } else {
          keys.push(fullKey)
        }
      }
      return keys
    }

    const allKeys = new Set<string>()
    for (const item of allItems) {
      for (const key of flattenKeys(item)) {
        allKeys.add(key)
      }
    }

    const headers = Array.from(allKeys)
    const csvRows = [headers.join(',')]

    for (const item of allItems) {
      const row = headers.map(key => {
        const value = getNestedValue(item, key)
        const str = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
        // Escape CSV special characters
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      })
      csvRows.push(row.join(','))
    }

    return csvRows.join('\n')
  })

  // ─── Bulk Action IPC Handlers ──────────────────────────────────────

  ipcMain.handle('action:create', async (_event, projectPath: string, config: Record<string, unknown>) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    let projectId = getProjectByPath(db.db, projectPath)?.id as string | undefined
    if (!projectId) {
      projectId = createProject(db.db, projectPath, getProjectName(projectPath))
    }

    return createBulkAction(db.db, { ...config, projectId })
  })

  ipcMain.handle('action:execute', async (_event, projectPath: string, actionId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    const actionRow = db.db.prepare('SELECT * FROM bulk_actions WHERE id = ?').get(actionId) as Record<string, unknown>
    if (!actionRow) throw new Error(`Action not found: ${actionId}`)

    const executor = new BulkActionExecutor(db.db)
    return executor.execute(
      actionId,
      projectPath,
      actionRow.source_collection as string,
      actionRow.target_collection as string,
      join(projectPath, actionRow.script_file as string),
      100
    )
  })

  // ─── Pipeline IPC Handlers ──────────────────────────────────────────

  ipcMain.handle('pipeline:create', async (_event, projectPath: string, name: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    let projectId = getProjectByPath(db.db, projectPath)?.id as string | undefined
    if (!projectId) {
      projectId = createProject(db.db, projectPath, getProjectName(projectPath))
    }

    return createPipeline(db.db, name, projectId)
  })

  ipcMain.handle('pipeline:add-stage', (_event, projectPath: string, pipelineId: string, stageConfig: Record<string, unknown>) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    addPipelineStage(db.db, { ...stageConfig, pipelineId })
  })

  ipcMain.handle('pipeline:get-stages', (_event, projectPath: string, pipelineId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    return db.db.prepare(
      'SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY order_num'
    ).all(pipelineId)
  })

  ipcMain.handle('pipeline:run', async (_event, projectPath: string, pipelineId: string, groupId?: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    let projectId = getProjectByPath(db.db, projectPath)?.id as string | undefined
    if (!projectId) {
      projectId = createProject(db.db, projectPath, getProjectName(projectPath))
    }

    const orchestrator = new PipelineOrchestrator(db.db)
    return orchestrator.runPipeline(pipelineId, projectId, projectPath, groupId)
  })

  ipcMain.handle('pipeline:trial-run', async (_event, projectPath: string, pipelineId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    let projectId = getProjectByPath(db.db, projectPath)?.id as string | undefined
    if (!projectId) {
      projectId = createProject(db.db, projectPath, getProjectName(projectPath))
    }

    const orchestrator = new PipelineOrchestrator(db.db)
    return orchestrator.executeTrialRun(pipelineId, projectId, projectPath, 3)
  })

  ipcMain.handle('pipeline:export-yaml', (_event, projectPath: string, pipelineId: string) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)
    const orchestrator = new PipelineOrchestrator(db.db)
    return orchestrator.exportPipelineToYaml(pipelineId)
  })

  // ─── Analysis Agent IPC Handlers ────────────────────────────────────

  ipcMain.handle('agent:create-config', async (_event, projectPath: string, config: Record<string, unknown>) => {
    const db = projectDbs.get(projectPath)
    if (!db) throw new Error(`No database connection for project: ${projectPath}`)

    let projectId = getProjectByPath(db.db, projectPath)?.id as string | undefined
    if (!projectId) {
      projectId = createProject(db.db, projectPath, getProjectName(projectPath))
    }

    return createAnalysisAgentConfig(db.db, config)
  })

  ipcMain.handle('agent:export-yaml', (_event, _projectPath: string, agentId: string) => {
    const yamlData = { id: agentId } // Simplified - would fetch from DB in production
    return exportToYaml(yamlData)
  })

  // ─── YAML Import/Export ─────────────────────────────────────────────

  ipcMain.handle('yaml:import', async (_event, yamlContent: string) => {
    try {
      return importFromYaml(yamlContent)
    } catch (err) {
      throw new Error(`Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  ipcMain.handle('yaml:export', (_event, data: Record<string, unknown>) => {
    return exportToYaml(data)
  })
}

// ─── Helper functions ──────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.')
  let current: unknown = obj
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

// ─── Cleanup on app quit ──────────────────────────────────────────────

export function cleanupAllDbs(): void {
  for (const [path, db] of projectDbs) {
    try {
      closeDb(db)
    } catch (err) {
      console.error(`Failed to close DB for ${path}:`, err)
    }
  }
  projectDbs.clear()
}
