import { useState, useEffect } from 'react'
import type { Pipeline } from '../types'

interface Props {
  projectPath: string
  onItemOpen: (id: string) => void
}

function PipelinesView({ projectPath, onItemOpen }: Props) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPipelines()
  }, [projectPath])

  const loadPipelines = async () => {
    try {
      const dir = await window.electronAPI.readDir(projectPath)
      const loaded = dir
        .filter(e => e.name.endsWith('.pipeline.yaml'))
        .map(async (e) => {
          const content = await window.electronAPI.readFile(e.path)
          if (content) {
            try {
              return { id: e.name.replace('.pipeline.yaml', ''), yaml: content }
            } catch {
              return null
            }
          }
          return null
        })
      const results = await Promise.all(loaded)
      setPipelines(
        results.filter(Boolean).map(r => ({
          id: r!.id,
          name: r!.id,
          stages: [],
          status: 'draft' as const
        }))
      )
    } catch (err) {
      console.error('Failed to load pipelines:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div>Loading...</div>

  return (
    <div>
      <h3 style={{ marginBottom: 16 }}>Pipelines</h3>
      {pipelines.length === 0 ? (
        <p style={{ color: '#8b949e' }}>No pipelines yet. Chain jobs together in a workflow.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pipelines.map(p => (
            <div
              key={p.id}
              onClick={() => onItemOpen(p.id)}
              style={{
                padding: 12,
                background: '#21262d',
                borderRadius: 6,
                cursor: 'pointer'
              }}
            >
              <div style={{ fontWeight: 500 }}>{p.name}</div>
              <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>
                {p.stages.length} stages • Status: {p.status}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default PipelinesView
