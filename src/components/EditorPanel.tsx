import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import type * as monacoType from 'monaco-editor'
import type { Tab } from '../App'
import type { Job, CollectionItem } from '../types'
import { generateVariations } from '../services/inference'
import { executePipeline, PipelineStageConfig } from '../services/pipeline'

interface Props {
  tab: Tab | undefined
  projectPath: string | null
}

function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(variables[key] ?? ''))
}

async function loadJsonFile<T>(path: string): Promise<T | null> {
  const content = await window.electronAPI.readFile(path)
  if (!content) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function EditorPanel({ tab, projectPath }: Props) {
  const [content, setContent] = useState<string>('')
  const [savedContent, setSavedContent] = useState<string>('')
  const [isRunning, setIsRunning] = useState(false)
  const [runProgress, setRunProgress] = useState({ current: 0, total: 0, status: '' })

  useEffect(() => {
    if (tab?.path) {
      loadFile(tab.path)
    }
  }, [tab])

  const loadFile = async (path: string) => {
    const data = await window.electronAPI.readFile(path)
    if (data !== null) {
      setContent(data)
      setSavedContent(data)
    }
  }

  const handleEditorMount = (_editor: any, monaco: typeof monacoType) => {
    monaco.languages.register({ id: 'jinja2' })

    monaco.languages.setMonarchTokensProvider('jinja2', {
      tokenizer: {
        root: [
          [/\{%[^}]*%\}/, 'keyword'],
          [/\{\{[^}]*\}\}/, 'variable'],
          [/#.*$/, 'comment'],
        ]
      }
    })
  }

  const handleChange = (value: string | undefined) => {
    setContent(value || '')
  }

  const saveFile = async () => {
    if (!tab?.path) return
    await window.electronAPI.writeFile(tab.path, content)
    setSavedContent(content)
  }

  const getLanguage = (filename: string): string => {
    if (filename.endsWith('.json')) return 'json'
    if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'yaml'
    if (filename.endsWith('.js')) return 'javascript'
    if (filename.endsWith('.jinja') || filename.endsWith('.j2')) return 'jinja2'
    if (filename.endsWith('.csv')) return 'plaintext'
    return 'plaintext'
  }

  const hasChanges = content !== savedContent
  const isJobFile = tab?.name.endsWith('.job.json')
  const isPipelineFile = tab?.name.endsWith('.pipeline.yaml')

  const runJob = async () => {
    if (!tab || !projectPath) return

    let job: Job | null = null
    try {
      job = JSON.parse(content) as Job
    } catch {
      alert('Invalid job configuration. Please fix JSON errors first.')
      return
    }

    if (!job.provider?.apiKey) {
      alert('Please set provider.apiKey in the job configuration first.')
      return
    }

    const templatePath = `${projectPath}/${job.templatePath}`
    const templateContent = await window.electronAPI.readFile(templatePath)
    if (!templateContent) {
      alert(`Could not read template file: ${job.templatePath}`)
      return
    }

    const inputData: Record<string, unknown>[] = []
    for (const inputFile of job.inputFiles) {
      const inputPath = `${projectPath}/${inputFile}`
      const parsed = await loadJsonFile<Record<string, unknown>[]>(inputPath)
      if (parsed) {
        inputData.push(...parsed)
      }
    }

    if (inputData.length === 0) {
      alert('No input data loaded. Please check inputFiles paths.')
      return
    }

    setIsRunning(true)
    setRunProgress({ current: 0, total: inputData.length, status: 'Starting...' })

    const results: CollectionItem[] = []
    const variations = generateVariations(inputData, job.samplingStrategy)

    try {
      for (let i = 0; i < variations.length; i++) {
        setRunProgress({ current: i + 1, total: variations.length, status: `Processing ${i + 1}/${variations.length}` })

        const vars = variations[i]
        const renderedPrompt = renderTemplate(templateContent, vars)
        const startTime = Date.now()

        try {
          const response = await fetch(`${job.provider.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${job.provider.apiKey}`
            },
            body: JSON.stringify({
              model: job.provider.model,
              messages: [{ role: 'user', content: renderedPrompt }],
              temperature: job.provider.temperature,
              max_tokens: job.provider.maxTokens
            })
          })

          const data = await response.json()
          const latencyMs = Date.now() - startTime
          const message = data.choices?.[0]?.message?.content || ''

          let parsedContent = message
          try {
            parsedContent = JSON.parse(message)
          } catch {
            // Keep as raw string if not valid JSON
          }

          results.push({
            id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            renderedPrompt,
            rawResponse: message,
            parsedContent,
            tokenUsage: {
              promptTokens: data.usage?.prompt_tokens || 0,
              completionTokens: data.usage?.completion_tokens || 0,
              totalTokens: data.usage?.total_tokens || 0
            },
            latencyMs,
            status: 'completed'
          })
        } catch (error) {
          results.push({
            id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            renderedPrompt,
            rawResponse: '',
            parsedContent: null,
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            latencyMs: Date.now() - startTime,
            status: 'errored',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      // Save results as collection
      const collectionId = `collection-${Date.now()}`
      const collectionPath = `${projectPath}/${collectionId}.collection.json`
      const collectionContent = {
        id: collectionId,
        name: job.name,
        createdAt: Date.now(),
        items: results
      }
      await window.electronAPI.writeFile(collectionPath, JSON.stringify(collectionContent, null, 2))

      // Update job status in place
      job.status = 'completed'
      job.results = results
      const updatedJobContent = JSON.stringify(job, null, 2)
      await window.electronAPI.writeFile(tab.path, updatedJobContent)
      setContent(updatedJobContent)
      setSavedContent(updatedJobContent)

      setRunProgress({ current: variations.length, total: variations.length, status: 'Done!' })
    } finally {
      setTimeout(() => {
        setIsRunning(false)
        setRunProgress({ current: 0, total: 0, status: '' })
      }, 1500)
    }
  }

  const runPipeline = async () => {
    if (!tab || !projectPath) return

    setIsRunning(true)
    setRunProgress({ current: 0, total: 1, status: 'Parsing pipeline...' })

    try {
      // Simple YAML parsing for basic fields
      const lines = content.split('\n')
      const yamlData: Record<string, unknown> = {}
      let inStages = false
      const stagesYaml: string[] = []

      for (const line of lines) {
        if (line.startsWith('stages:')) {
          inStages = true
          continue
        }
        if (inStages) {
          if (line.match(/^[a-z]/)) {
            inStages = false
          } else {
            stagesYaml.push(line)
          }
        }
        const match = line.match(/^(\w+):\s*(.+)$/)
        if (match && !inStages) {
          yamlData[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
        }
      }

      // Parse stages from YAML array format
      const stages: PipelineStageConfig[] = []
      let currentStage: Record<string, string> | null = null

      for (const line of stagesYaml) {
        if (line.includes('- id:')) {
          if (currentStage) stages.push(currentStage as unknown as PipelineStageConfig)
          currentStage = { id: line.split('id:')[1].trim() }
        } else if (currentStage && line.match(/^\s+(type|name):\s*/)) {
          const [, key, value] = line.match(/^\s+(\w+):\s*(.+)$/) || []
          if (key) currentStage[key] = value.replace(/^['"]|['"]$/g, '')
        }
      }
      if (currentStage) stages.push(currentStage as unknown as PipelineStageConfig)

      if (stages.length === 0) {
        alert('No stages defined in pipeline. Add stages first.')
        return
      }

      // Load input data from files referenced in pipeline config
      const inputFiles = (yamlData.inputFiles as string || '').split(',').filter(Boolean)
      const baseUrl = yamlData.baseUrl as string || 'https://api.openai.com/v1'
      const apiKey = yamlData.apiKey as string || ''
      const model = yamlData.model as string || 'gpt-4o-mini'

      if (!apiKey) {
        alert('Please set apiKey in pipeline YAML.')
        return
      }

      let inputData: Record<string, unknown>[] = []
      for (const file of inputFiles) {
        const path = `${projectPath}/${file.trim()}`
        const parsed = await loadJsonFile<Record<string, unknown>[]>(path)
        if (parsed) inputData.push(...parsed)
      }

      if (inputData.length === 0) {
        alert('No input data. Please check inputFiles in pipeline YAML.')
        return
      }

      setRunProgress({ current: 1, total: stages.length + 1, status: 'Starting pipeline...' })

      const result = await executePipeline(
        stages,
        inputData,
        { baseUrl, apiKey, model, temperature: 0.7, maxTokens: 1024 },
        (stageIndex, stageName, status) => {
          setRunProgress({ current: stageIndex + 2, total: stages.length + 1, status: `${stageName}: ${status}` })
        }
      )

      // Save pipeline output as collection
      const collectionId = `pipeline-${Date.now()}`
      const collectionPath = `${projectPath}/${collectionId}.collection.json`
      const collectionContent = {
        id: collectionId,
        name: `Pipeline Output - ${yamlData.name || 'Untitled'}`,
        createdAt: Date.now(),
        items: result.outputs.map((o, i) => ({
          id: `item-${Date.now()}-${i}`,
          renderedPrompt: '',
          rawResponse: JSON.stringify(o),
          parsedContent: o,
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
          status: 'completed'
        }))
      }
      await window.electronAPI.writeFile(collectionPath, JSON.stringify(collectionContent, null, 2))

      setRunProgress({ current: stages.length + 1, total: stages.length + 1, status: `Done! ${result.summary.totalItems} items processed` })
    } catch (error) {
      alert(`Pipeline error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setTimeout(() => {
        setIsRunning(false)
        setRunProgress({ current: 0, total: 0, status: '' })
      }, 2000)
    }
  }

  if (!tab) {
    return <div className="editor-container"><div className="empty-state">No file selected</div></div>
  }

  return (
    <div className="editor-container">
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '8px 16px',
        background: '#161b22',
        borderBottom: '1px solid #30363d'
      }}>
        <span style={{ fontSize: 13, color: '#8b949e' }}>{tab.path}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isRunning && (
            <span style={{ fontSize: 12, color: '#f0883e' }}>
              {runProgress.status} ({runProgress.current}/{runProgress.total})
            </span>
          )}
          {!isRunning && hasChanges && (
            <button className="btn btn-primary" onClick={saveFile}>Save</button>
          )}
          {!isRunning && isJobFile && (
            <button className="btn btn-primary" onClick={runJob}>Run Job</button>
          )}
          {!isRunning && isPipelineFile && (
            <button className="btn btn-primary" onClick={runPipeline}>Run Pipeline</button>
          )}
        </div>
      </div>

      {isRunning && runProgress.total > 0 && (
        <div style={{
          padding: '8px 16px',
          background: '#21262d',
          borderBottom: '1px solid #30363d'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: '#c9d1d9' }}>{runProgress.status}</span>
            <div style={{
              flex: 1,
              height: 4,
              background: '#30363d',
              borderRadius: 2
            }}>
              <div style={{
                width: `${(runProgress.current / runProgress.total) * 100}%`,
                height: '100%',
                background: '#238636',
                borderRadius: 2,
                transition: 'width 0.3s'
              }} />
            </div>
          </div>
        </div>
      )}

      <div className="editor-wrapper">
        <Editor
          height="100%"
          language={getLanguage(tab.name)}
          value={content}
          onChange={handleChange}
          theme="vs-dark"
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2
          }}
        />
      </div>
    </div>
  )
}

export default EditorPanel