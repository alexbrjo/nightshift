import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface StageConfig {
  template_path?: string
  script_path?: string
  inline_script?: string
  input_files?: string[]
  [key: string]: any
}

interface Stage {
  id: string
  type: 'inference' | 'js_action' | 'filter' | 'transform' | 'aggregate'
  name: string
  position: { x: number; y: number }
  config?: StageConfig
  input_schema?: string
  output_schema?: string
}

export default function WorkflowEditor() {
  const [stages, setStages] = useState<Stage[]>([])
  const [selectedStage, setSelectedStage] = useState<string | null>(null)
  
  const addStage = (type: Stage['type']) => {
    const newStage: Stage = {
      id: `stage-${Date.now()}`,
      type,
      name: `${type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} ${stages.length + 1}`,
      position: { x: 100, y: 100 + stages.length * 150 },
      config: {}
    }
    setStages([...stages, newStage])
  }
  
  const updateStage = (id: string, updates: Partial<Stage>) => {
    setStages(stages.map(s => s.id === id ? { ...s, ...updates } : s))
  }
  
  const removeStage = (id: string) => {
    setStages(stages.filter(s => s.id !== id))
    if (selectedStage === id) setSelectedStage(null)
  }
  
  const getStageIcon = (type: Stage['type']) => {
    switch (type) {
      case 'inference': return '🤖'
      case 'js_action': return '⚡'
      case 'filter': return '🔍'
      case 'transform': return '🔄'
      case 'aggregate': return '📊'
    }
  }
  
  const selectedStageData = stages.find(s => s.id === selectedStage)
  
  const savePipelineDefinition = async () => {
    if (stages.length === 0) return
    
    const pipelineName = prompt('Enter pipeline name:') || 'Untitled Pipeline'
    
    // Convert stages to pipeline definition format
    const definition = {
      name: pipelineName,
      stages: stages.map(stage => ({
        id: stage.id,
        name: stage.name,
        stage_type: stage.type.toUpperCase(),
        config: stage.config || {},
        input_schema: stage.input_schema,
        output_schema: stage.output_schema
      }))
    }
    
    try {
      await invoke('save_pipeline', { 
        params: { 
          name: pipelineName,
          definition_yaml: JSON.stringify(definition, null, 2)
        } 
      })
      alert('Pipeline saved successfully!')
    } catch (error) {
      console.error('Failed to save pipeline:', error)
      alert('Failed to save pipeline')
    }
  }
  
  return (
    <div className="flex h-full">
      {/* Stage palette */}
      <div className="w-48 bg-gray-800 border-r border-gray-700 p-4 flex-shrink-0">
        <h3 className="text-sm font-semibold mb-3">Add Stage</h3>
        <div className="space-y-2">
          {(['inference', 'js_action', 'filter', 'transform', 'aggregate'] as const).map((type) => (
            <button
              key={type}
              onClick={() => addStage(type)}
              className="w-full px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm flex items-center gap-2"
            >
              <span>{getStageIcon(type)}</span>
              <span className="capitalize">{type.replace('_', ' ')}</span>
            </button>
          ))}
        </div>
        
        {stages.length > 0 && (
          <>
            <h3 className="text-sm font-semibold mt-6 mb-3">Pipeline</h3>
            <button
              onClick={savePipelineDefinition}
              className="w-full px-3 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm"
            >
              Save Pipeline
            </button>
          </>
        )}
      </div>
      
      {/* Workflow canvas */}
      <div className="flex-1 bg-gray-900 relative overflow-auto">
        {stages.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500">
            <p>Add stages to build your pipeline</p>
          </div>
        ) : (
          <>
            {/* Connection lines */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none">
              {stages.slice(0, -1).map((stage, i) => (
                <line
                  key={i}
                  x1={stage.position.x + 120}
                  y1={stage.position.y + 30}
                  x2={stage.position.x + 120}
                  y2={stages[i + 1].position.y - 10}
                  stroke="#4b5563"
                  strokeWidth="2"
                />
              ))}
            </svg>
            
            {/* Stage nodes */}
            {stages.map((stage) => (
              <div
                key={stage.id}
                style={{ left: stage.position.x, top: stage.position.y }}
                onClick={() => setSelectedStage(stage.id)}
                className={`absolute w-48 bg-gray-800 border rounded-lg p-3 shadow-lg cursor-pointer transition-colors ${
                  selectedStage === stage.id 
                    ? 'border-primary-500 ring-2 ring-primary-500/20' 
                    : 'border-gray-600 hover:border-gray-500'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span>{getStageIcon(stage.type)}</span>
                  <span className="font-medium text-sm">{stage.name}</span>
                </div>
                <div className="text-xs text-gray-400 mt-1 capitalize">
                  {stage.type.replace('_', ' ')}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeStage(stage.id); }}
                  className="absolute top-1 right-1 w-5 h-5 bg-red-600 hover:bg-red-700 rounded text-xs flex items-center justify-center"
                >
                  ×
                </button>
              </div>
            ))}
          </>
        )}
      </div>
      
      {/* Stage configuration panel */}
      {selectedStageData && (
        <div className="w-80 bg-gray-800 border-l border-gray-700 p-4 flex-shrink-0 overflow-auto">
          <h3 className="text-sm font-semibold mb-4">Configure Stage</h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium mb-1">Name</label>
              <input
                type="text"
                value={selectedStageData.name}
                onChange={(e) => updateStage(selectedStageData.id, { name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500"
              />
            </div>
            
            <div>
              <label className="block text-xs font-medium mb-1">Type</label>
              <select
                value={selectedStageData.type}
                onChange={(e) => updateStage(selectedStageData.id, { type: e.target.value as Stage['type'] })}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500"
              >
                <option value="inference">Inference</option>
                <option value="js_action">JS Action</option>
                <option value="filter">Filter</option>
                <option value="transform">Transform</option>
                <option value="aggregate">Aggregate</option>
              </select>
            </div>
            
            {/* Type-specific config */}
            {selectedStageData.type === 'inference' && (
              <>
                <div>
                  <label className="block text-xs font-medium mb-1">Template Path</label>
                  <input
                    type="text"
                    value={selectedStageData.config?.template_path || ''}
                    onChange={(e) => updateStage(selectedStageData.id, { 
                      config: { ...selectedStageData.config, template_path: e.target.value } 
                    })}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500"
                    placeholder="prompts/template.jinja"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Input Files (comma-separated)</label>
                  <input
                    type="text"
                    value={selectedStageData.config?.input_files?.join(', ') || ''}
                    onChange={(e) => updateStage(selectedStageData.id, { 
                      config: { ...selectedStageData.config, input_files: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } 
                    })}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500"
                    placeholder="data/input.json, data/extra.jsonl"
                  />
                </div>
              </>
            )}
            
            {selectedStageData.type === 'js_action' && (
              <>
                <div>
                  <label className="block text-xs font-medium mb-1">Script Path</label>
                  <input
                    type="text"
                    value={selectedStageData.config?.script_path || ''}
                    onChange={(e) => updateStage(selectedStageData.id, { 
                      config: { ...selectedStageData.config, script_path: e.target.value } 
                    })}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500"
                    placeholder="scripts/transform.js"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Or Inline Script</label>
                  <textarea
                    value={selectedStageData.config?.inline_script || ''}
                    onChange={(e) => updateStage(selectedStageData.id, { 
                      config: { ...selectedStageData.config, inline_script: e.target.value } 
                    })}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500 h-24 font-mono"
                    placeholder="function transform(item) { return item; }"
                  />
                </div>
              </>
            )}
            
            {/* Schema contracts */}
            <div className="pt-4 border-t border-gray-700">
              <h4 className="text-xs font-semibold mb-2">Schema Contracts</h4>
              <div>
                <label className="block text-xs font-medium mb-1">Output Schema (JSON)</label>
                <textarea
                  value={selectedStageData.output_schema || ''}
                  onChange={(e) => updateStage(selectedStageData.id, { output_schema: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500 h-24 font-mono"
                  placeholder='{"type": "object", "properties": {...}}'
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
