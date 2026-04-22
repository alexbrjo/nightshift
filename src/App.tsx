import { useState } from 'react'
import { useProjectStore } from './store/project'
import Sidebar from './components/Sidebar'
import Editor from './components/Editor'
import Toolbar from './components/Toolbar'
import StatusBar from './components/StatusBar'

function App() {
  const [activeTab, setActiveTab] = useState<'files' | 'collections' | 'jobs' | 'pipelines'>('files')
  
  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
        <Editor />
      </div>
      <StatusBar />
    </div>
  )
}

export default App
