import { useState } from 'react'
import { useProjectStore } from '../store/project'
import InferenceJobForm from './InferenceJobForm'

interface Job {
  id: string
  name: string
  type: 'inference' | 'js_action'
  status: 'pending' | 'running' | 'completed' | 'error'
  progress: number
}

export default function JobsPanel() {
  const { jobs } = useProjectStore()
  const [showInferenceForm, setShowInferenceForm] = useState(false)
  
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-gray-500'
      case 'running': return 'bg-blue-500 animate-pulse'
      case 'completed': return 'bg-green-500'
      case 'error': return 'bg-red-500'
      default: return 'bg-gray-500'
    }
  }
  
  return (
    <>
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Jobs</h2>
          <button 
            onClick={() => setShowInferenceForm(true)}
            className="px-3 py-1 bg-primary-600 hover:bg-primary-700 rounded text-sm"
          >
            New Job
          </button>
        </div>
        
        {jobs.length === 0 ? (
          <p className="text-gray-500 text-sm">No jobs yet</p>
        ) : (
          <div className="space-y-2">
            {(jobs as Job[]).map((job) => (
              <div key={job.id} className="p-3 bg-gray-800 rounded">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">{job.name}</span>
                  <div className={`w-3 h-3 rounded-full ${getStatusColor(job.status)}`} />
                </div>
                <div className="text-sm text-gray-400 capitalize">{job.type.replace('_', ' ')}</div>
                {job.status === 'running' && (
                  <div className="mt-2 bg-gray-700 rounded-full h-1.5">
                    <div 
                      className="bg-primary-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      
      <InferenceJobForm isOpen={showInferenceForm} onClose={() => setShowInferenceForm(false)} />
    </>
  )
}
