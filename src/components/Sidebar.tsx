import { useProjectStore } from '../store/project'
import FileTree from './FileTree'
import CollectionsPanel from './CollectionsPanel'
import JobsPanel from './JobsPanel'
import PipelinesPanel from './PipelinesPanel'

interface SidebarProps {
  activeTab: 'files' | 'collections' | 'jobs' | 'pipelines'
  setActiveTab: (tab: 'files' | 'collections' | 'jobs' | 'pipelines') => void
}

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const { isOpen } = useProjectStore()
  
  return (
    <div className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col">
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => setActiveTab('files')}
          className={`px-4 py-2 text-sm ${activeTab === 'files' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Files
        </button>
        <button
          onClick={() => setActiveTab('collections')}
          className={`px-4 py-2 text-sm ${activeTab === 'collections' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Collections
        </button>
        <button
          onClick={() => setActiveTab('jobs')}
          className={`px-4 py-2 text-sm ${activeTab === 'jobs' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Jobs
        </button>
        <button
          onClick={() => setActiveTab('pipelines')}
          className={`px-4 py-2 text-sm ${activeTab === 'pipelines' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Pipelines
        </button>
      </div>
      
      <div className="flex-1 overflow-auto">
        {isOpen ? (
          <>
            {activeTab === 'files' && <FileTree />}
            {activeTab === 'collections' && <CollectionsPanel />}
            {activeTab === 'jobs' && <JobsPanel />}
            {activeTab === 'pipelines' && <PipelinesPanel />}
          </>
        ) : (
          <div className="p-4 text-center text-gray-500">
            <p>No project open</p>
            <p className="text-sm mt-2">Open a folder to get started</p>
          </div>
        )}
      </div>
    </div>
  )
}
