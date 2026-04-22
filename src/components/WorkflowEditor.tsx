import { useState } from 'react'

interface Stage {
  id: string
  type: 'inference' | 'js_action' | 'filter' | 'transform' | 'aggregate'
  name: string
  position: { x: number; y: number }
}

export default function WorkflowEditor() {
  const [stages, setStages] = useState<Stage[]>([])
  
  const addStage = (type: Stage['type']) => {
    const newStage: Stage = {
      id: `stage-${Date.now()}`,
      type,
      name: `${type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} ${stages.length + 1}`,
      position: { x: 100, y: 100 + stages.length * 150 },
    }
    setStages([...stages, newStage])
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
  
  return (
    <div className="flex h-full">
      <div className="w-48 bg-gray-800 border-r border-gray-700 p-4">
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
      </div>
      
      <div className="flex-1 bg-gray-900 relative overflow-auto">
        {stages.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500">
            <p>Add stages to build your pipeline</p>
          </div>
        ) : (
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
        )}
        
        {stages.map((stage) => (
          <div
            key={stage.id}
            style={{ left: stage.position.x, top: stage.position.y }}
            className="absolute w-48 bg-gray-800 border border-gray-600 rounded-lg p-3 shadow-lg"
          >
            <div className="flex items-center gap-2">
              <span>{getStageIcon(stage.type)}</span>
              <span className="font-medium text-sm">{stage.name}</span>
            </div>
            <div className="text-xs text-gray-400 mt-1 capitalize">
              {stage.type.replace('_', ' ')}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
