import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import fs from 'fs/promises'
import { 
  initDb, 
  saveInferenceJob, 
  getInferenceJobs, 
  updateInferenceJobStatus, 
  saveCollectionItem, 
  getCollectionItems, 
  deleteCollectionItem, 
  saveBulkActionResult, 
  getBulkActionResults, 
  savePipeline, 
  getPipelines, 
  saveAgent, 
  getAgents, 
  saveAgentRun, 
  getAgentRuns 
} from './db'
import { InferenceJob, BulkActionConfig, Pipeline, AgentConfig, AgentRun, BulkActionResult } from '../common/models'
import { runSandboxedScript } from './sandbox'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  // For development, we'll try to load from the Vite dev server URL if it's provided via env
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  if (canceled) {
    return null
  } else {
    return filePaths[0]
  }
})

ipcMain.handle('fs:readDirectory', async (_event, dirPath: string) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries.map(entry => ({
    name: entry.name,
    path: join(dirPath, entry.name),
    isDirectory: entry.isDirectory()
  }))
})

ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
  return await fs.readFile(filePath, 'utf-8')
})

ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
  await fs.writeFile(filePath, content, 'utf-8')
  return true
})

ipcMain.handle('fs:deleteFile', async (_event, filePath: string) => {
  await fs.unlink(filePath)
  return true
})

ipcMain.handle('jobs:create', async (_event, config: any) => {
  const job: InferenceJob = {
    id: Math.random().toString(36).substring(2, 15),
    config: config,
    status: 'pending',
    createdAt: Date.now()
  }
  saveInferenceJob(job)
  return job
})

ipcMain.handle('jobs:get', async () => {
  return getInferenceJobs()
})

ipcMain.handle('collections:getItems', async (_event, jobId: string) => {
  return getCollectionItems(jobId)
})

ipcMain.handle('collections:deleteItem', async (_event, itemId: string) => {
  deleteCollectionItem(itemId)
  return true
})

ipcMain.handle('bulk-actions:run', async (_event, config: BulkActionConfig) => {
  const result: BulkActionResult = {
    id: Math.random().toString(36).substring(2, 15),
    actionName: config.name,
    status: 'running',
    createdAt: Date.now()
  }
  saveBulkActionResult(result)

  try {
    const script = await fs.readFile(config.scriptPath, 'utf-8')
    const items = await getCollectionItems(config.sourceCollectionId)

    for (const item of items) {
      try {
        const processedData = await runSandboxedScript(script, item.data)
        await saveCollectionItem(config.targetCollectionId, processedData)
      } catch (err) {
        console.error(`Failed to process item ${item.id}:`, err)
      }
    }

    result.status = 'completed'
  } catch (err) {
    console.error('Bulk action failed:', err)
    result.status = 'errored'
  }

  return result
})

ipcMain.handle('bulk-actions:getResults', async () => {
  return getBulkActionResults()
})

ipcMain.handle('pipelines:create', async (_event, config: any) => {
  const pipeline: Pipeline = {
    id: Math.random().toString(36).substring(2, 15),
    config: config,
    status: 'pending',
    createdAt: Date.now()
  }
  savePipeline(pipeline)
  return pipeline
})

ipcMain.handle('pipelines:get', async () => {
  return getPipelines()
})

ipcMain.handle('agents:create', async (_event, config: AgentConfig) => {
  const agent = {
    id: Math.random().toString(36).substring(2, 15),
    config: config
  }
  saveAgent(agent)
  return agent
})

ipcMain.handle('agents:get', async () => {
  return getAgents()
})

ipcMain.handle('agent-runs:create', async (_event, run: AgentRun) => {
  saveAgentRun(run)
  return run
})

ipcMain.handle('agent-runs:get', async (_event, agentId: string) => {
  return getAgentRuns(agentId)
})

app.whenReady().then(() => {
  initDb()
  createWindow()

  app.on('activate', function activate() {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
