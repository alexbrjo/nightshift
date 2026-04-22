import { useState } from 'react'
import WorkflowEditor from './WorkflowEditor'

export default function PipelinesPanel() {
  const [pipelines] = useState<any[]>([])
  const [showEditor, setShowEditor] = useState(false)
  
  return (
    <div className="h-full flex flex-col">
      {!showEditor ? (
        <>
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Pipelines</h2>
              <button 
                onClick={() => setShowEditor(true)}
                className="px-3 py-1 bg-primary-600 hover:bg-primary-700 rounded text-sm"
              >
                New Pipeline
              </button>
            </div>
            
            {pipelines.length === 0 ? (
              <p className="text-gray-500 text-sm">No pipelines yet</p>
            ) : (
              <div className="space-y-2">
                {pipelines.map((pipeline) => (
                  <div key={pipeline.id} className="p-3 bg-gray-800 rounded">
                    <div className="font-medium">{pipeline.name}</div>
                    <div className="text-sm text-gray-400 mt-1">
                      {pipeline.stages?.length || 0} stages
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <WorkflowEditor />
      )}
    </div>
  )
}
