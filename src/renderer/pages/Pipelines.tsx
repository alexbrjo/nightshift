import { useState, useEffect, useCallback } from 'react'

interface PipelineStageDef {
  id: string
  stage_type: string
  name: string
  order_num: number
  job_id?: string
  action_id?: string
  agent_config_id?: string
}

export default function Pipelines({ projectPath }: { projectPath: string }): JSX.Element {
  const [pipelines, setPipelines] = useState<Array<{ id: string; name: string }>>([])
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null)
  const [stages, setStages] = useState<PipelineStageDef[]>([])
  const [showCreateForm, setShowCreateForm] = useState(false)

  // Create form state
  const [pipelineName, setPipelineName] = useState('')
  const [stageType, setStageType] = useState<'inference' | 'javascript-action' | 'analysis-agent'>('inference')
  const [stageName, setStageName] = useState('')

  // Run state
  const [isRunning, setIsRunning] = useState(false)
  const [trialRunning, setTrialRunning] = useState(false)
  const [runStatus, setRunStatus] = useState<string | null>(null)

  useEffect(() => {
    loadPipelines()
  }, [])

  useEffect(() => {
    if (selectedPipelineId) {
      loadStages(selectedPipelineId)
    }
  }, [selectedPipelineId])

  const loadPipelines = useCallback(async (): Promise<void> => {
    // In production, fetch from DB - simplified for now
    setPipelines([])
  }, [])

  const loadStages = useCallback(async (pipelineId: string): Promise<void> => {
    try {
      const data = await window.nightshift.pipeline.getStages(projectPath, pipelineId)
      setStages(data as PipelineStageDef[])
    } catch (err) {
      console.error('Failed to load stages:', err)
      setStages([])
    }
  }, [projectPath])

  const handleCreatePipeline = useCallback(async (): Promise<void> => {
    if (!pipelineName.trim()) return

    try {
      const pipelineId = await window.nightshift.pipeline.create(projectPath, pipelineName)
      setSelectedPipelineId(pipelineId)
      setShowCreateForm(false)
      setPipelines(prev => [...prev, { id: pipelineId, name: pipelineName }])
      setStages([])
    } catch (err) {
      console.error('Failed to create pipeline:', err)
    }
  }, [projectPath, pipelineName])

  const handleAddStage = useCallback(async (): Promise<void> => {
    if (!selectedPipelineId || !stageName.trim()) return

    try {
      await window.nightshift.pipeline.addStage(projectPath, selectedPipelineId, {
        stageType: stageType === 'inference' ? 'inference' : stageType === 'javascript-action' ? 'javascript-action' : 'analysis-agent',
        name: stageName,
        orderNum: stages.length,
      })

      setStageName('')
      loadStages(selectedPipelineId)
    } catch (err) {
      console.error('Failed to add stage:', err)
    }
  }, [projectPath, selectedPipelineId, stageType, stageName, stages.length, loadStages])

  const handleRun = useCallback(async (): Promise<void> => {
    if (!selectedPipelineId) return
    setIsRunning(true)
    setRunStatus('running')

    try {
      await window.nightshift.pipeline.run(projectPath, selectedPipelineId)
      setRunStatus('completed')
    } catch (err) {
      setRunStatus('errored')
    } finally {
      setIsRunning(false)
    }
  }, [projectPath, selectedPipelineId])

  const handleTrialRun = useCallback(async (): Promise<void> => {
    if (!selectedPipelineId) return
    setTrialRunning(true)
    setRunStatus('trial-running')

    try {
      await window.nightshift.pipeline.trialRun(projectPath, selectedPipelineId)
      setRunStatus('trial-completed')
    } catch (err) {
      setRunStatus('trial-errored')
    } finally {
      setTrialRunning(false)
    }
  }, [projectPath, selectedPipelineId])

  const handleExportYaml = useCallback(async (): Promise<void> => {
    if (!selectedPipelineId) return

    try {
      const yamlContent = await window.nightshift.pipeline.exportYaml(projectPath, selectedPipelineId)
      const blob = new Blob([yamlContent], { type: 'text/yaml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `pipeline-${selectedPipelineId}.yaml`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export pipeline:', err)
    }
  }, [projectPath, selectedPipelineId])

  const stageTypeLabels: Record<string, string> = {
    inference: '⚡ Inference',
    'javascript-action': '📜 JS Action',
    'analysis-agent': '🤖 Agent',
  }

  return (
    <div style={{ maxWidth: '900px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2>Experiment Pipelines</h2>
        <button className="btn btn-primary" onClick={() => setShowCreateForm(!showCreateForm)}>
          {showCreateForm ? 'Cancel' : '+ New Pipeline'}
        </button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div style={{ background: 'var(--bg-secondary)', padding: 20, borderRadius: 8, marginBottom: 24, border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: 14, marginBottom: 16 }}>New Pipeline</h3>
          <div className="form-group">
            <label className="form-label">Pipeline Name</label>
            <input className="form-input" value={pipelineName} onChange={e => setPipelineName(e.target.value)} placeholder="My experiment pipeline" />
          </div>
          <button className="btn btn-primary" onClick={handleCreatePipeline}>Create Pipeline</button>
        </div>
      )}

      {/* Pipeline list */}
      {pipelines.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          {pipelines.map(p => (
            <div key={p.id} className={`job-item ${selectedPipelineId === p.id ? 'active' : ''}`} onClick={() => setSelectedPipelineId(p.id)}>
              <span>{p.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Pipeline editor */}
      {selectedPipelineId && (
        <div style={{ background: 'var(--bg-secondary)', padding: 20, borderRadius: 8, border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3>Pipeline Stages</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-sm" onClick={handleTrialRun} disabled={trialRunning}>
                {trialRunning ? 'Trial Running...' : 'Trial Run'}
              </button>
              <button className="btn btn-sm btn-primary" onClick={handleRun} disabled={isRunning}>
                {isRunning ? 'Running...' : 'Full Run'}
              </button>
              <button className="btn btn-sm" onClick={handleExportYaml}>Export YAML</button>
            </div>
          </div>

          {/* Run status */}
          {runStatus && (
            <div style={{ marginBottom: 16 }}>
              <span className={`status-badge status-${runStatus.includes('error') ? 'errored' : runStatus === 'running' || runStatus === 'trial-running' ? 'running' : 'completed'}`}>
                {runStatus}
              </span>
            </div>
          )}

          {/* Stage visualization */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
            {stages.map((stage, i) => (
              <>
                <div className="pipeline-stage-node">
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{stage.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{stageTypeLabels[stage.stage_type] ?? stage.stage_type}</div>
                </div>
                {i < stages.length - 1 && <span className="pipeline-arrow">→</span>}
              </>
            ))}
          </div>

          {/* Add stage form */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Stage Name</label>
              <input className="form-input" value={stageName} onChange={e => setStageName(e.target.value)} placeholder="My stage" />
            </div>
            <div className="form-group" style={{ width: 180 }}>
              <label className="form-label">Type</label>
              <select className="form-select" value={stageType} onChange={e => setStageType(e.target.value as typeof stageType)}>
                <option value="inference">Inference Job</option>
                <option value="javascript-action">JS Action</option>
                <option value="analysis-agent">Analysis Agent</option>
              </select>
            </div>
            <button className="btn" onClick={handleAddStage}>+ Add Stage</button>
          </div>

          {stages.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No stages yet. Add a stage to get started.
            </div>
          )}
        </div>
      )}

      {!showCreateForm && pipelines.length === 0 && (
        <div className="not-implemented">Create a new pipeline to chain jobs together</div>
      )}
    </div>
  )
}
