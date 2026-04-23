const { ipcRenderer } = window.require('electron');

const App = () => {
  const [view, setView] = React.useState('editor'); // editor, inference, js_actions, collections, pipeline, agent
  const [projectPath, setProjectPath] = React.useState(null);
  const [files, setFiles] = React.useState([]);
  const [activeFile, setActiveFile] = React.useState(null);
  const [fileContent, setFileContent] = React.useState('');
  
  // Inference State
  const [infConfig, setInfConfig] = React.useState({ template: '', model: 'gpt-4', temperature: 0.7, maxTokens: 1000, apiKey: '' });
  const [inputDataRaw, setInputDataRaw] = React.useState('[]');

  // JS Actions State
  const [jsCode, setJsCode] = React.useState('');
  const [jsDataRaw, setJsDataRaw] = React.useState('[]');

  // Collections State
  const [collectionResults, setCollectionResults] = React.useState([]);

  // Pipeline State
  const [pipelineDef, setPipelineDef] = React.useState('{"stages": []}');
  const [pipeInputRaw, setPipeInputRaw] = React.useState('[]');

  const openProject = async () => {
    const path = await ipcRenderer.invoke('open-directory');
    if (path) {
      setProjectPath(path);
      await loadFiles(path);
    }
  };

  const loadFiles = async (dirPath) => {
    const list = await ipcRenderer.invoke('list-directory', dirPath);
    setFiles(list);
  };

  const openFile = async (fileName) => {
    setActiveFile(fileName);
    const fullPath = `${projectPath}/${fileName}`;
    const content = await ipcRenderer.invoke('read-file', fullPath);
    setFileContent(content);
    setView('editor');
  };

  const saveFile = async () => {
    if (!activeFile) return;
    const fullPath = `${projectPath}/${activeFile}`;
    await ipcRenderer.invoke('write-file', { filePath: fullPath, content: fileContent });
    alert('File saved!');
  };

  const runInference = async () => {
    try {
      const inputData = JSON.parse(inputDataRaw);
      const res = await ipcRenderer.invoke('run-inference-job', { 
        projectPath, jobConfig: infConfig, inputData, apiKey: infConfig.apiKey 
      });
      alert(`Job completed! Job ID: ${res.jobId}`);
      fetchSamples(res.jobId);
    } catch (e) { alert('Error: ' + e.message); }
  };

  const runJS = async () => {
    try {
      const inputData = JSON.parse(jsDataRaw);
      const res = await ipcRenderer.invoke('run-js-job', { projectPath, code: jsCode, inputData });
      alert(`Job completed! Job ID: ${res.jobId}`);
      fetchSamples(res.jobId);
    } catch (e) { alert('Error: ' + e.message); }
  };

  const fetchSamples = async (jobId) => {
    const samples = await ipcRenderer.invoke('get-samples', { projectPath, jobId });
    setCollectionResults(samples);
    setView('collections');
  };

  const runPipeline = async () => {
    try {
      const inputData = JSON.parse(pipeInputRaw);
      const res = await ipcRenderer.invoke('run-pipeline', { 
        projectPath, pipelineDef, inputData, apiKey: infConfig.apiKey 
      });
      alert('Pipeline completed!');
      console.log('Results:', res);
    } catch (e) { alert('Error: ' + e.message); }
  };

  const runAgent = async () => {
    try {
      const report = await ipcRenderer.invoke('run-analysis-agent', { 
        projectPath, apiKey: infConfig.apiKey 
      });
      alert('Analysis complete! Check analysis.md');
      console.log('Report:', report);
    } catch (e) { alert('Error: ' + e.message); }
  };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100vh' }}>
      <div id="sidebar" style={{ width: '250px', background: '#f0f0f0', borderRight: '1px solid #ccc', padding: '10px', overflowY: 'auto' }}>
        <h3>Nightshift</h3>
        <button onClick={openProject} style={{ width: '100%', marginBottom: '10px' }}>Open Project</button>
        {projectPath && <p style={{fontSize: '12px'}}> {projectPath}</p>}
        
        <div style={{ marginBottom: '20px', borderTop: '1px solid #ccc', paddingTop: '10px' }}>
          <button onClick={() => setView('editor')} style={{ width: '100%', textAlign: 'left', padding: '5px' }}>📁 Files</button>
          <button onClick={() => setView('inference')} style={{ width: '100%', textAlign: 'left', padding: '5px' }}>⚡ Bulk Inference</button>
          <button onClick={() => setView('js_actions')} style={{ width: '100%', textAlign: 'left', padding: '5px' }}>⚙️ JS Actions</button>
          <button onClick={() => setView('collections')} style={{ width: '100%', textAlign: 'left', padding: '5px' }}>📊 Collections</button>
          <button onClick={() => setView('pipeline')} style={{ width: '100%', textAlign: 'left', padding: '5px' }}>⛓️ Pipeline</button>
          <button onClick={() => setView('agent')} style={{ width: '100%', textAlign: 'left', padding: '5px' }}>🤖 Analysis Agent</button>
        </div>

        {view === 'editor' && (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {files.map(file => (
              <li key={file} 
                  className={`file-item ${activeFile === file ? 'active-file' : ''}`} 
                  onClick={() => openFile(file)}
                  style={{ cursor: 'pointer', padding: '4px', borderRadius: '3px' }}>
                {file}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div id="editor-container" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {view === 'editor' && (
          <>
            <div id="toolbar" style={{ height: '40px', background: '#ddd', borderBottom: '1px solid #ccc', display: 'flex', alignItems: 'center', padding: '0 10px', gap: '10px' }}>
              {activeFile && (
                <>
                  <span>Editing: {activeFile}</span>
                  <button onClick={saveFile}>Save</button>
                </>
              )}
            </div>
            <div id="main-content" style={{ flex: 1 }}>
              {activeFile ? (
                <textarea 
                  style={{ width: '100%', height: '100%', border: 'none', padding: '10px', fontSize: '14px', fontFamily: 'monospace' }}
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                />
              ) : (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  Please select a file.
                </div>
              )}
            </div>
          </>
        )}

        {view === 'inference' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Bulk Inference</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '600px' }}>
              <label>API Key:</label>
              <input type="password" value={infConfig.apiKey} onChange={e => setInfConfig({...infConfig, apiKey: e.target.value})} />
              <label>Model:</label>
              <input value={infConfig.model} onChange={e => setInfConfig({...infConfig, model: e.target.value})} />
              <label>Template (Jinja):</label>
              <textarea rows="5" value={infConfig.template} onChange={e => setInfConfig({...infConfig, template: e.target.value})} />
              <label>Input Data (JSON Array):</label>
              <textarea rows="10" value={inputDataRaw} onChange={e => setInputDataRaw(e.target.value)} />
              <button onClick={runInference}>Run Job</button>
            </div>
          </div>
        )}

        {view === 'js_actions' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Bulk JS Actions</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '600px' }}>
              <label>JS Code:</label>
              <textarea rows="10" value={jsCode} onChange={e => setJsCode(e.target.value)} 
                placeholder="const result = { val: data.name.toUpperCase() }; return result;" />
              <label>Input Data (JSON Array):</label>
              <textarea rows="10" value={jsDataRaw} onChange={e => setJsDataRaw(e.target.value)} />
              <button onClick={runJS}>Run Job</button>
            </div>
          </div>
        )}

        {view === 'collections' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Collections</h2>
            <table border="1" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Input</th>
                  <th>Output/Result</th>
                  <th>Metrics</th>
                </tr>
              </thead>
              <tbody>
                {collectionResults.map(s => (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td>{s.status}</td>
                    <td>{JSON.stringify(s.input_data)}</td>
                    <td>{s.raw_response || JSON.stringify(s.parsed_content)}</td>
                    <td>{JSON.stringify(s.metrics)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {view === 'pipeline' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Experiment Pipeline</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '600px' }}>
              <label>Pipeline Definition (JSON):</label>
              <textarea rows="15" value={pipelineDef} onChange={e => setPipelineDef(e.target.value)} 
                placeholder='{"stages": [{"type": "inference", "config": {...}}, {"type": "javascript", "config": {...}}]}' />
              <label>Input Data (JSON Array):</label>
              <textarea rows="10" value={pipeInputRaw} onChange={e => setPipeInputRaw(e.target.value)} />
              <button onClick={runPipeline}>Execute Pipeline</button>
            </div>
          </div>
        )}

        {view === 'agent' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Analysis Agent</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '600px' }}>
              <p>The agent will analyze all samples in the project DB and generate a report.</p>
              <label>API Key:</label>
              <input type="password" value={infConfig.apiKey} onChange={e => setInfConfig({...infConfig, apiKey: e.target.value})} />
              <button onClick={runAgent}>Run Analysis Agent</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

      </div>

      <div id="editor-container" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {view === 'editor' && (
          <>
            <div id="toolbar" style={{ height: '40px', background: '#ddd', borderBottom: '1px solid #ccc', display: 'flex', alignItems: 'center', padding: '0 10px', gap: '10px' }}>
              {activeFile && (
                <>
                  <span>Editing: {activeFile}</span>
                  <button onClick={saveFile}>Save</button>
                </>
              )}
            </div>
            <div id="main-content" style={{ flex: 1 }}>
              {activeFile ? (
                <textarea 
                  style={{ width: '100%', height: '100%', border: 'none', padding: '10px', fontSize: '14px', fontFamily: 'monospace' }}
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                />
              ) : (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  Please select a file.
                </div>
              )}
            </div>
          </>
        )}

        {view === 'inference' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Bulk Inference</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '600px' }}>
              <label>API Key:</label>
              <input type="password" value={infConfig.apiKey} onChange={e => setInfConfig({...infConfig, apiKey: e.target.value})} />
              <label>Model:</label>
              <input value={infConfig.model} onChange={e => setInfConfig({...infConfig, model: e.target.value})} />
              <label>Template (Jinja):</label>
              <textarea rows="5" value={infConfig.template} onChange={e => setInfConfig({...infConfig, template: e.target.value})} />
              <label>Input Data (JSON Array):</label>
              <textarea rows="10" value={inputDataRaw} onChange={e => setInputDataRaw(e.target.value)} />
              <button onClick={runInference}>Run Job</button>
            </div>
          </div>
        )}

        {view === 'js_actions' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Bulk JS Actions</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '600px' }}>
              <label>JS Code:</label>
              <textarea rows="10" value={jsCode} onChange={e => setJsCode(e.target.value)} 
                placeholder="const result = { val: data.name.toUpperCase() }; return result;" />
              <label>Input Data (JSON Array):</label>
              <textarea rows="10" value={jsDataRaw} onChange={e => setJsDataRaw(e.target.value)} />
              <button onClick={runJS}>Run Job</button>
            </div>
          </div>
        )}

        {view === 'collections' && (
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <h2>Collections</h2>
            <table border="1" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Input</th>
                  <th>Output/Result</th>
                  <th>Metrics</th>
                </tr>
              </thead>
              <tbody>
                {collectionResults.map(s => (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td>{s.status}</td>
                    <td>{JSON.stringify(s.input_data)}</td>
                    <td>{s.raw_response || JSON.stringify(s.parsed_content)}</td>
                    <td>{JSON.stringify(s.metrics)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

