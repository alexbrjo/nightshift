import { useState, useEffect } from 'react'
import axios from 'axios'

interface Job {
  id: number
  name: string
  description?: string
  project_id: number
  status: string
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [projectId] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return parseInt(params.get('projectId') || '0')
  })

  useEffect(() => {
    fetchJobs()
  }, [projectId])

  async function fetchJobs() {
    try {
      const response = await axios.get(
        `http://localhost:8000/api/jobs?project_id=${projectId}`
      )
      setJobs(response.data)
    } catch (error) {
      console.error('Failed to fetch jobs:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateJob() {
    const name = prompt('Enter job name:')
    if (!name) return

    const templatePath = prompt('Enter template path:', 'templates/prompts.yaml')
    if (!templatePath) return

    try {
      await axios.post('http://localhost:8000/api/jobs', {
        project_id: projectId,
        name,
        template_path: templatePath,
        description: '',
      })
      fetchJobs()
    } catch (error) {
      console.error('Failed to create job:', error)
      alert('Error creating job')
    }
  }

  async function handleRunJob(jobId: number) {
    try {
      await axios.post(`http://localhost:8000/api/jobs/${jobId}/run`)
      alert('Job started!')
      fetchJobs()
    } catch (error) {
      console.error('Failed to run job:', error)
      alert('Error running job')
    }
  }

  if (loading) {
    return <div style={{ padding: '24px' }}>Loading...</div>
  }

  return (
    <div className="jobs-page">
      <div className="page-header">
        <h1>Jobs</h1>
        <button className="btn-primary" onClick={handleCreateJob}>
          New Job
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="empty-state">
          <p>No jobs yet. Create one to run inference tasks.</p>
        </div>
      ) : (
        <div className="job-list">
          {jobs.map((job) => {
            const statusColor =
              job.status === 'running'
                ? '#3b82f6'
                : job.status === 'completed'
                ? '#10b981'
                : job.status === 'failed'
                ? '#ef4444'
                : '#f59e0b'

            return (
              <div key={job.id} className="card">
                <div className="job-header">
                  <h3>{job.name}</h3>
                  <span
                    className="status-badge"
                    style={{ backgroundColor: statusColor }}
                  >
                    {job.status}
                  </span>
                </div>
                <p>{job.description}</p>
                {job.status !== 'running' && (
                  <button
                    className="btn-secondary"
                    onClick={() => handleRunJob(job.id)}
                  >
                    ▶ Run Job
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
