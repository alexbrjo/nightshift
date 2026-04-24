import { useState, useEffect, useCallback } from 'react'

interface JobInfo {
  id: string
  name: string
  status: string
  totalSamples: number
  completedSamples: number
  erroredSamples: number
}

export default function BulkInference({ projectPath }: { projectPath: string }): JSX.Element {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  // Form state
  const [jobName, setJobName] = useState('')
  const [templateFile, setTemplateFile] = useState('')
  const [sourceDataType, setSourceDataType] = useState<'file' | 'collection'>('file')
  const [sourceDataPath, setSourceDataPath] = useState('')
  const [apiEndpoint, setApiEndpoint] = useState('https://api.openai.com/v1')
  const [modelName, setModelName] = useState('gpt-4o')
  const [outputMode, setOutputMode] = useState<'unstructured' | 'plain-json' | 'schema-validated'>('plain-json')
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(4096)
  const [samplingStrategy, setSamplingStrategy] = useState<'single' | 'random' | 'exhaustive'>('single')
  const [numSamples, setNumSamples] = useState(1)

  // Results state
  const [results, setResults] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadJobs()
  }, [])

  useEffect(() => {
    if (selectedJobId) {
      loadResults(selectedJobId)
    }
  }, [selectedJobId])

  // Poll for job progress
  useEffect(() => {
    if (!selectedJobId) return

    const interval = setInterval(async () => {
      try {
        const status = await window.nightshift.job.getStatus(projectPath, selectedJobId)
        setJobs(prev => prev.map(j =>
          j.id === selectedJobId ? { ...j, status: status.status, completedSamples: status.completed_samples, erroredSamples: status.errored_samples } : j
        ))

        // If job is done, reload results
        if (status.status === 'completed' || status.status === 'errored') {
          loadResults(selectedJobId)
        }
      } catch { /* ignore polling errors */ }
    }, 2000)

    return () => clearInterval(interval)
  }, [selectedJobId, projectPath])

  const loadJobs = useCallback(async (): Promise<void> => {
    // In production, fetch from DB - simplified for now
    setLoading(false)
  }, [])

  const loadResults = useCallback(async (jobId: string): Promise<void> => {
    try {
      const data = await window.nightshift.job.getResults(projectPath, jobId)
      setResults(data as Record<string, unknown>[])
    } catch (err) {
      console.error('Failed to load results:', err)
    }
  }, [projectPath])

  const handleCreateJob = useCallback(async (): Promise<void> => {
    try {
      const jobId = await window.nightshift.job.create(projectPath, {
        name: jobName,
        samplingStrategy,
        numSamples,
        templateFile,
        sourceDataType,
        sourceDataPath: sourceDataType === 'file' ? sourceDataPath : undefined,
        apiEndpoint,
        modelName,
        outputMode,
        temperature,
        maxTokens,
        totalSamples: numSamples,
      })

      setSelectedJobId(jobId)
      setShowForm(false)
      setJobs(prev => [...prev, { id: jobId, name: jobName, status: 'pending', totalSamples: numSamples, completedSamples: 0, erroredSamples: 0 }])
    } catch (err) {
      console.error('Failed to create job:', err)
    }
  }, [projectPath, jobName, samplingStrategy, numSamples, templateFile, sourceDataType, sourceDataPath, apiEndpoint, modelName, outputMode, temperature, maxTokens])

  const handleExportYaml = useCallback(async (jobId: string): Promise<void> => {
    try {
      const yamlContent = await window.nightshift.job.exportYaml(projectPath, jobId)
      const blob = new Blob([yamlContent], { type: 'text/yaml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `job-${jobId}.yaml`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export job:', err)
    }
  }, [projectPath])

  const selectedJob = jobs.find(j => j.id === selectedJobId)
  const progress = selectedJob ? ((selectedJob.completedSamples + selectedJob.erroredSamples) / Math.max(selectedJob.totalSamples, 1)) * 100 : 0

  return (
    <div style={{ maxWidth: '900px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2>Bulk Inference</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ New Job'}
        </button>
      </div>

      {/* Job creation form */}
      {showForm && (
        <div style={{ background: 'var(--bg-secondary)', padding: 20, borderRadius: 8, marginBottom: 24, border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: 14, marginBottom: 16 }}>New Inference Job</h3>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Job Name</label>
              <input className="form-input" value={jobName} onChange={e => setJobName(e.target.value)} placeholder="My inference job" />
            </div>
            <div className="form-group">
              <label className="form-label">Model</label>
              <input className="form-input" value={modelName} onChange={e => setModelName(e.target.value)} placeholder="gpt-4o" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">API Endpoint</label>
            <input className="form-input" value={apiEndpoint} onChange={e => setApiEndpoint(e.target.value)} placeholder="https://api.openai.com/v1" />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Template File</label>
              <input className="form-input" value={templateFile} onChange={e => setTemplateFile(e.target.value)} placeholder="prompts/example.jinja2" />
            </div>
            <div className="form-group">
              <label className="form-label">Sampling Strategy</label>
              <select className="form-select" value={samplingStrategy} onChange={e => setSamplingStrategy(e.target.value as typeof samplingStrategy)}>
                <option value="single">Single (first N)</option>
                <option value="random">Random</option>
                <option value="exhaustive">Exhaustive (all)</option>
              </select>
            </div>
          </div>

          {samplingStrategy !== 'exhaustive' && (
            <div className="form-group">
              <label className="form-label">Number of Samples</label>
              <input className="form-input" type="number" min={1} value={numSamples} onChange={e => setNumSamples(parseInt(e.target.value) || 1)} />
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Source Data Type</label>
              <select className="form-select" value={sourceDataType} onChange={e => setSourceDataType(e.target.value as typeof sourceDataType)}>
                <option value="file">File</option>
                <option value="collection">Collection</option>
              </select>
            </div>
            {sourceDataType === 'file' && (
              <div className="form-group">
                <label className="form-label">Source File Path</label>
                <input className="form-input" value={sourceDataPath} onChange={e => setSourceDataPath(e.target.value)} placeholder="data/input.jsonl" />
              </div>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Output Mode</label>
              <select className="form-select" value={outputMode} onChange={e => setOutputMode(e.target.value as typeof outputMode)}>
                <option value="unstructured">Unstructured</option>
                <option value="plain-json">Plain JSON</option>
                <option value="schema-validated">Schema Validated</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Temperature</label>
              <input className="form-input" type="number" min={0} max={2} step={0.1} value={temperature} onChange={e => setTemperature(parseFloat(e.target.value))} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Max Tokens</label>
            <input className="form-input" type="number" min={1} value={maxTokens} onChange={e => setMaxTokens(parseInt(e.target.value) || 4096)} />
          </div>

          <button className="btn btn-primary" onClick={handleCreateJob}>Create & Run Job</button>
        </div>
      )}

      {/* Job list sidebar */}
      {jobs.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>Jobs</h3>
          {jobs.map(job => (
            <div key={job.id} className={`job-item ${selectedJobId === job.id ? 'active' : ''}`} onClick={() => setSelectedJobId(job.id)}>
              <span>{job.name}</span>
              <span className={`status-badge status-${job.status}`}>
                {job.completedSamples}/{job.totalSamples}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Job results */}
      {selectedJob && (
        <div style={{ background: 'var(--bg-secondary)', padding: 20, borderRadius: 8, border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3>{selectedJob.name}</h3>
            <button className="btn btn-sm" onClick={() => handleExportYaml(selectedJob.id)}>Export YAML</button>
          </div>

          {/* Progress */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span className={`status-badge status-${selectedJob.status}`}>{selectedJob.status}</span>
            <div className="progress-bar" style={{ flex: 1 }}>
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{selectedJob.completedSamples} completed, {selectedJob.erroredSamples} errored</span>
          </div>

          {/* Results table */}
          {results.length > 0 ? (
            <div className="collection-table-wrapper" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Status</th>
                    <th>Prompt Preview</th>
                    <th>Response Preview</th>
                    <th>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result, i) => (
                    <tr key={(result.id as string) || i}>
                      <td>{(result.sample_index as number) ?? i}</td>
                      <td><span className={`status-badge status-${String(result.status ?? 'pending')}`}>{String(result.status ?? '')}</span></td>
                      <td title={String(result.rendered_prompt ?? '')}>{String(result.rendered_prompt ?? '').slice(0, 100)}...</td>
                      <td title={String(result.raw_response ?? '')}>{String(result.raw_response ?? '').slice(0, 100)}...</td>
                      <td>{result.latency_ms ? `${Math.round(Number(result.latency_ms))}ms` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
              {selectedJob.status === 'pending' ? 'Waiting to start...' : selectedJob.status === 'running' ? 'Processing samples...' : 'No results yet'}
            </div>
          )}
        </div>
      )}

      {!showForm && jobs.length === 0 && (
        <div className="not-implemented">Create a new inference job to get started</div>
      )}
    </div>
  )
}
