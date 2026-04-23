import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import log from 'electron-log'
import * as db from './database'

log.initialize()
log.transports.file.level = 'INFO'
log.info('Nightshift starting...')

process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error)
  app.exit(1)
})

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  log.info('Main window created')
}

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData')
  db.initDatabase(userDataPath)
  log.info('Database initialized at:', path.join(userDataPath, 'data', 'nightshift.db'))
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  return result.filePaths[0] || null
})

ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries.map(e => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      path: path.join(dirPath, e.name)
    }))
  } catch (error) {
    log.error('Error reading directory:', error)
    return []
  }
})

ipcMain.handle('fs:readFile', async (_, filePath: string) => {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    log.error('Error reading file:', error)
    return null
  }
})

ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, content, 'utf-8')
    return true
  } catch (error) {
    log.error('Error writing file:', error)
    return false
  }
})

ipcMain.handle('fs:exists', async (_, filePath: string) => {
  return fs.existsSync(filePath)
})

ipcMain.handle('app:getUserDataPath', () => app.getPath('userData'))

ipcMain.handle('db:insertCollection', async (_, data) => {
  try {
    db.insertCollection(data)
    return true
  } catch (error) {
    log.error('Error inserting collection:', error)
    return false
  }
})

ipcMain.handle('db:getCollections', async () => {
  try {
    return db.getCollections()
  } catch (error) {
    log.error('Error getting collections:', error)
    return []
  }
})

ipcMain.handle('db:insertCollectionItem', async (_, data) => {
  try {
    db.insertCollectionItem(data)
    return true
  } catch (error) {
    log.error('Error inserting collection item:', error)
    return false
  }
})

ipcMain.handle('db:getCollectionItems', async (_, collectionId: string) => {
  try {
    return db.getCollectionItems(collectionId)
  } catch (error) {
    log.error('Error getting collection items:', error)
    return []
  }
})
