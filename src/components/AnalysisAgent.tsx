import { useState } from 'react'

interface AgentStep {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'error'
  output?: string
}

export default function AnalysisAgent() {
  const [experimentId, setExperimentId] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [steps, setSteps] = useState<AgentStep[]>([
    { id: 'query', name: 'Run Analysis Query', status: 'pending' },
    { id: 'supplement', name: 'Supplement with Anecdotes', status: 'pending' },
    { id: 'summary', name: 'Write Summary', status: 'pending' },
    { id: 'proofread', name: 'Proofread', status: 'pending' },
  ])
  
  const runAgent = async () => {
    if (!experimentId) return
    
    setIsRunning(true)
    
    for (let i = 0; i < steps.length; i++) {
      setSteps(prev => prev.map((step, idx) => 
        idx === i ? { ...step, status: 'running' } : step
      ))
      
      // Simulate step execution
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      setSteps(prev => prev.map((step, idx) => 
        idx === i ? { ...step, status: 'completed', output: 'Step completed' } : step
      ))
    }
    
    setIsRunning(false)
  }
  
  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-4">Analysis Agent</h2>
      
      <div className="mb-6">
        <label className="block text-sm font-medium mb-1">Experiment Run ID</label>
        <input
          type="text"
          value={experimentId}
          onChange={(e) => setExperimentId(e.target.value)}
          disabled={isRunning}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500 disabled:opacity-50"
          placeholder="Enter experiment run ID"
        />
      </div>
      
      <div className="space-y-4 mb-6">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center gap-4 p-3 bg-gray-800 rounded">
            <div className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-700">
              {index + 1}
            </div>
            
            <div className="flex-1">
              <div className="font-medium">{step.name}</div>
              <div className={`text-sm ${
                step.status === 'completed' ? 'text-green-500' :
                step.status === 'running' ? 'text-blue-500' :
                step.status === 'error' ? 'text-red-500' :
                'text-gray-500'
              }`}>
                {step.status}
              </div>
            </div>
            
            {step.status === 'running' && (
              <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            )}
          </div>
        ))}
      </div>
      
      <button
        onClick={runAgent}
        disabled={!experimentId || isRunning}
        className="w-full px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded disabled:opacity-50"
      >
        {isRunning ? 'Running Analysis...' : 'Run Analysis Agent'}
      </button>
      
      {steps[steps.length - 1].status === 'completed' && (
        <div className="mt-4 p-3 bg-green-900/20 border border-green-700 rounded">
          <p className="text-green-400 text-sm">Analysis complete! Check analysis.md for results.</p>
        </div>
      )}
    </div>
  )
}
