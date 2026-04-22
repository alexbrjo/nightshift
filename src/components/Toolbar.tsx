import { useProjectStore } from '../store/project'

export default function Toolbar() {
  const { isOpen, closeProject } = useProjectStore()
  
  const handleOpenProject = async () => {
    // In a real app, this would use Tauri's dialog API
    // For now, we'll just show an alert
    alert('Use Ctrl+O or the menu to open a project folder')
  }
  
  return (
    <div className="h-12 bg-gray-800 border-b border-gray-700 flex items-center px-4 gap-4">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-lg">Nightshift</span>
      </div>
      
      <div className="h-6 w-px bg-gray-600" />
      
      <nav className="flex items-center gap-1">
        <button className="px-3 py-1.5 text-sm hover:bg-gray-700 rounded">File</button>
        <button className="px-3 py-1.5 text-sm hover:bg-gray-700 rounded">Edit</button>
        <button className="px-3 py-1.5 text-sm hover:bg-gray-700 rounded">View</button>
        <button className="px-3 py-1.5 text-sm hover:bg-gray-700 rounded">Run</button>
        <button className="px-3 py-1.5 text-sm hover:bg-gray-700 rounded">Help</button>
      </nav>
      
      <div className="flex-1" />
      
      {isOpen ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400 truncate max-w-xs">
            {useProjectStore.getState().path}
          </span>
          <button
            onClick={closeProject}
            className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 rounded"
          >
            Close Project
          </button>
        </div>
      ) : (
        <button
          onClick={handleOpenProject}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm"
        >
          Open Project
        </button>
      )}
    </div>
  )
}
