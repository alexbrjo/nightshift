import { useState, useEffect } from 'react'
import type { Job } from '../types'

interface Props {
  projectPath: string
  onItemOpen: (id: string) => void
  onCreate: () => void
}

function JobsView({ projectPath, onItemOpen }: Props) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadJobs()
  }, [projectPath])

  const loadJobs = async () => {
    try {
      const dir = await window.electronAPI.readDir(projectPath)
      const loadedJobs = dir
        .filter(e => e.name.endsWith('.job.json'))
        .map(async (e) => {
          const content = await window.electronAPI.readFile(e.path)
          if (content) {
            try {
              return JSON.parse(content) as Job
            } catch {
              return null
            }
          }
          return null
        })
      const results = await Promise.all(loadedJobs)
      setJobs(results.filter(Boolean) as Job[])
    } catch (err) {
      console.error('Failed to load jobs:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div>Loading...</div>

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return '#f0883e'
      case 'completed': return '#238636'
      case 'error': return '#da3633'
      default: return '#8b949e'
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Jobs</h3>
        <button className="btn btn-primary" onClick={onCreate}>+ New</button>
      </div>
      {jobs.length === 0 ? (
        <p style={{ color: '#8b949e' }}>No jobs yet. Create a job configuration to start bulk inference.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {jobs.map(j => (
            <div
              key={j.id}
              onClick={() => onItemOpen(j.id)}
              style={{
                padding: 12,
                background: '#21262d',
                borderRadius: 6,
                cursor: 'pointer'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 500 }}>{j.name}</span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 12,
                    fontSize: 11,
                    background: getStatusColor(j.status),
                    color: '#fff'
                  }}
                >
                  {j.status}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>
                {j.results.length} results • Strategy: {j.samplingStrategy}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default JobsView
