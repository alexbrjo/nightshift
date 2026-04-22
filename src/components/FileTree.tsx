import { useState } from 'react'
import { useProjectStore, DirectoryEntry } from '../store/project'

export default function FileTree() {
  const { files, listDirectory, readFile, currentFile } = useProjectStore()
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  
  const handleFileClick = async (entry: DirectoryEntry) => {
    if (entry.is_directory) {
      const newExpanded = new Set(expandedDirs)
      if (expandedDirs.has(entry.path)) {
        newExpanded.delete(entry.path)
      } else {
        newExpanded.add(entry.path)
        await listDirectory(entry.path)
      }
      setExpandedDirs(newExpanded)
    } else {
      await readFile(entry.path)
    }
  }
  
  const getIcon = (entry: DirectoryEntry) => {
    if (entry.is_directory) return '📁'
    
    const ext = entry.name.split('.').pop()?.toLowerCase()
    switch (ext) {
      case 'jinja':
      case 'jinja2':
        return '🎨'
      case 'json':
      case 'jsonl':
        return '📋'
      case 'js':
      case 'ts':
        return '⚡'
      case 'csv':
        return '📊'
      case 'yaml':
      case 'yml':
        return '🔧'
      case 'md':
        return '📝'
      default:
        return '📄'
    }
  }
  
  return (
    <div className="p-2">
      {files.map((entry) => (
        <div
          key={entry.path}
          onClick={() => handleFileClick(entry)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-gray-700 ${
            currentFile?.path === entry.path ? 'bg-gray-700' : ''
          }`}
        >
          <span className="text-sm">{getIcon(entry)}</span>
          <span className="text-sm truncate">{entry.name}</span>
        </div>
      ))}
    </div>
  )
}
