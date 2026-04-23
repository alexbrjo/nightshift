const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ProjectDB = require('../shared/db');
const InferenceEngine = require('../shared/inference');
const Sandbox = require('../shared/sandbox');
const PipelineEngine = require('../shared/pipeline');
const AnalysisAgent = require('../shared/agent');

let mainWindow;
const projectDbs = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);

ipcMain.handle('open-directory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (canceled) return null;
  const projectPath = filePaths[0];
  
  if (!projectDbs.has(projectPath)) {
    projectDbs.set(projectPath, new ProjectDB(projectPath));
  }
  
  return projectPath;
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw err;
  }
});

ipcMain.handle('write-file', async (event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (err) {
    throw err;
  }
});

ipcMain.handle('list-directory', async (event, dirPath) => {
  try {
    return fs.readdirSync(dirPath);
  } catch (err) {
    throw err;
  }
});

ipcMain.handle('run-inference-job', async (event, { projectPath, jobConfig, inputData, apiKey }) => {
  const db = projectDbs.get(projectPath);
  const engine = new InferenceEngine(apiKey);
  
  const jobId = db.run('INSERT INTO jobs (name, type, config) VALUES (?, ?, ?)', 
    ['Inference Job', 'inference', JSON.stringify(jobConfig)]).lastInsertRowid;

  const results = await engine.runJob(jobConfig, inputData);
  
  for (const res of results) {
    db.run('INSERT INTO samples (job_id, input_data, rendered_prompt, raw_response, metrics, status) VALUES (?, ?, ?, ?, ?, ?)', 
      [jobId, JSON.stringify(res.input), res.prompt, res.raw, JSON.stringify(res.metrics), res.error ? 'error' : 'completed']);
  }

  return { jobId, results };
});

ipcMain.handle('run-js-job', async (event, { projectPath, code, inputData }) => {
  const db = projectDbs.get(projectPath);
  const jobId = db.run('INSERT INTO jobs (name, type, config) VALUES (?, ?, ?)', 
    ['JS Job', 'javascript', JSON.stringify({ code })]).lastInsertRowid;

  const results = inputData.map(data => {
    const res = Sandbox.execute(code, data);
    return { input: data, result: res.result, error: res.error };
  });

  for (const res of results) {
    db.run('INSERT INTO samples (job_id, input_data, parsed_content, status) VALUES (?, ?, ?, ?)', 
      [jobId, JSON.stringify(res.input), JSON.stringify(res.result), res.error ? 'error' : 'completed']);
  }

  return { jobId, results };
});

ipcMain.handle('get-samples', async (event, { projectPath, jobId }) => {
  const db = projectDbs.get(projectPath);
  return db.query('SELECT * FROM samples WHERE job_id = ?', [jobId]);
});

ipcMain.handle('run-pipeline', async (event, { projectPath, pipelineDef, inputData, apiKey }) => {
  const db = projectDbs.get(projectPath);
  const pipeline = new PipelineEngine(apiKey, db);
  const finalResults = await pipeline.executePipeline(pipelineDef, inputData);
  return finalResults;
});

ipcMain.handle('run-analysis-agent', async (event, { projectPath, apiKey }) => {
  const db = projectDbs.get(projectPath);
  const agent = new AnalysisAgent(apiKey, db);
  const report = await agent.runAnalysis();
  
  // Save to analysis.md in project root
  const filePath = path.join(projectPath, 'analysis.md');
  fs.writeFileSync(filePath, report, 'utf8');
  
  return report;
});



