import React, { useState } from 'react'
import { InferenceJobConfig, SamplingStrategy, OutputMode } from '../../../common/models'

interface Props {
  onSave: (config: InferenceJobConfig) => void;
}

const InferenceJobForm: React.FC<Props> = ({ onSave }) => {
  const [config, setConfig] = useState<InferenceJobConfig>({
    name: '',
    numSamples: 1,
    samplingStrategy: 'single',
    promptFile: '',
    sourceData: { type: 'file', path: '' },
    apiHostname: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
    outputMode: 'unstructured',
    temperature: 0.7,
    tokenLimit: 2048,
    thinkingBudget: 0,
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(config)
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
      <div>
        <label>Job Name:</label><br />
        <input 
          type="text" 
          value={config.name} 
          onChange={(e) => setConfig({ ...config, name: e.target.value })} 
          required 
        />
      </div>

      <div>
        <label>Number of Samples:</label><br />
        <input 
          type="number" 
          min="1" 
          value={config.numSamples} 
          onChange={(e) => setConfig({ ...config, numSamples: parseInt(e.target.value) })} 
          required 
        />
      </div>

      <div>
        <label>Sampling Strategy:</label><br />
        <select 
          value={config.samplingStrategy} 
          onChange={(e) => setConfig({ ...config, samplingStrategy: e.target.value as SamplingStrategy })}
        >
          <option value="single">Single</option>
          <option value="random">Random</option>
          <option value="exhaustive">Exhaustive</option>
        </select>
      </div>

      <div>
        <label>Prompt File Path:</label><br />
        <input 
          type="text" 
          value={config.promptFile} 
          onChange={(e) => setConfig({ ...config, promptFile: e.target.value })} 
          required 
        />
      </div>

      <div>
        <label>Source Data Type:</label><br />
        <select 
          value={config.sourceData.type} 
          onChange={(e) => setConfig({ ...config, sourceData: { ...config.sourceData, type: e.target.value as 'file' | 'collection' } })}
        >
          <option value="file">File</option>
          <option value="collection">Collection</option>
        </select>
      </div>

      <div>
        <label>Source Data Path:</label><br />
        <input 
          type="text" 
          value={config.sourceData.path} 
          onChange={(e) => setConfig({ ...config, sourceData: { ...config.sourceData, path: e.target.value } })} 
          required 
        />
      </div>

      <div>
        <label>API Hostname:</label><br />
        <input 
          type="text" 
          value={config.apiHostname} 
          onChange={(e) => setConfig({ ...config, apiHostname: e.target.value })} 
          required 
        />
      </div>

      <div>
        <label>Model Name:</label><br />
        <input 
          type="text" 
          value={config.modelName} 
          onChange={(e) => setConfig({ ...config, modelName: e.target.value })} 
          required 
        />
      </div>

      <div>
        <label>Output Mode:</label><br />
        <select 
          value={config.outputMode} 
          onChange={(e) => setConfig({ ...config, outputMode: e.target.value as OutputMode })}
        >
          <option value="unstructured">Unstructured</option>
          <option value="plain_json">Plain JSON</option>
          <option value="json_schema">JSON Schema</option>
        </select>
      </div>

      <div>
        <label>Temperature:</label><br />
        <input 
          type="number" 
          step="0.1" 
          min="0" 
          max="2" 
          value={config.temperature} 
          onChange={(e) => setConfig({ ...config, temperature: parseFloat(e.target.value) })} 
          required 
        />
      </div>

      <div>
        <label>Token Limit:</label><br />
        <input 
          type="number" 
          min="1" 
          value={config.tokenLimit} 
          onChange={(e) => setConfig({ ...config, tokenLimit: parseInt(e.target.value) })} 
          required 
        />
      </div>

      <div>
        <label>Thinking Budget:</label><br />
        <input 
          type="number" 
          min="0" 
          value={config.thinkingBudget} 
          onChange={(e) => setConfig({ ...config, thinkingBudget: parseInt(e.target.value) })} 
          required 
        />
      </div>

      <button type="submit">Create Job</button>
    </form>
  )
}

export default InferenceJobForm
