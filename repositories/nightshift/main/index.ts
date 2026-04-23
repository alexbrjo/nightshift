import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { registerFileHandlers } from './ipc/file-handlers';
import { registerInferenceHandlers } from './ipc/inference-handlers';
import { registerPipelineHandlers } from './ipc/pipeline-handlers';
import { registerAgentHandlers } from './ipc/agent-handlers';
import { ProjectManager } from './project-manager';

let mainWindow: BrowserWindow | null = null;
const projectManager = new ProjectManager();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Nightshift',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }

  registerAllHandlers();
}

function registerAllHandlers(): void {
  registerFileHandlers(projectManager);
  registerInferenceHandlers(projectManager);
  registerPipelineHandlers(projectManager);
  registerAgentHandlers(projectManager);

  ipcMain.handle('open-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Open Project Directory',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const projectPath = result.filePaths[0];
    await projectManager.openProject(projectPath);
    return { path: projectPath, name: path.basename(projectPath) };
  });

  ipcMain.handle('get-current-project', () => {
    return projectManager.getCurrentProject();
  });

  ipcMain.handle('close-project', async () => {
    await projectManager.closeProject();
  });

  ipcMain.handle('get-settings', () => {
    return projectManager.getSettings();
  });

  ipcMain.handle('save-settings', (_event, settings) => {
    projectManager.saveSettings(settings);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  projectManager.closeAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  projectManager.closeAll();
});
