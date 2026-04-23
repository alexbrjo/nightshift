import { useState } from 'react'

export interface PipelineStage {
  id: string
  type: 'inference' | 'js-action' | 'evaluation'
  name: string
  config: Record<string, unknown>
}

interface Props {
  stages: PipelineStage[]
  onChange: (stages: PipelineStage[]) => void
}

function PipelineEditor({ stages, onChange }: Props) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  const addStage = (type: 'inference' | 'js-action' | 'evaluation') => {
    const newStage: PipelineStage = {
      id: `stage-${Date.now()}`,
      type,
      name: `${type} ${stages.length + 1}`,
      config: {}
    }
    onChange([...stages, newStage])
  }

  const removeStage = (index: number) => {
    onChange(stages.filter((_, i) => i !== index))
  }

  const moveStage = (fromIndex: number, toIndex: number) => {
    const newStages = [...stages]
    const [moved] = newStages.splice(fromIndex, 1)
    newStages.splice(toIndex, 0, moved)
    onChange(newStages)
  }

  const getStageIcon = (type: string) => {
    switch (type) {
      case 'inference': return '{ }'
      case 'js-action': return 'JS'
      case 'evaluation': return '📊'
      default: return '⚙️'
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h3>Pipeline Editor</h3>
      
      <div style={{ display: 'flex', gap: 8, marginTop: 16, marginBottom: 24 }}>
        {(['inference', 'js-action', 'evaluation'] as const).map(type => (
          <button
            key={type}
            className="btn btn-secondary"
            onClick={() => addStage(type)}
          >
            + Add {type.replace('-', ' ')}
          </button>
        ))}
      </div>

      {stages.length === 0 ? (
        <p style={{ color: '#8b949e' }}>Add stages to build your pipeline workflow</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {stages.map((stage, index) => (
            <div
              key={stage.id}
              draggable
              onDragStart={() => setDraggedIndex(index)}
              onDragEnd={() => setDraggedIndex(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (draggedIndex !== null && draggedIndex !== index) {
                  moveStage(draggedIndex, index)
                }
              }}
              style={{
                padding: 16,
                background: '#21262d',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                cursor: 'grab'
              }}
            >
              <span style={{ fontSize: 20 }}>{getStageIcon(stage.type)}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{stage.name}</div>
                <div style={{ fontSize: 12, color: '#8b949e' }}>Type: {stage.type}</div>
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => removeStage(index)}
                style={{ padding: '4px 8px' }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {stages.length > 1 && (
        <div style={{ marginTop: 24 }}>
          <p style={{ fontSize: 13, color: '#8b949e' }}>
            Drag stages to reorder. Output from each stage feeds into the next.
          </p>
        </div>
      )}
    </div>
  )
}

export default PipelineEditor
