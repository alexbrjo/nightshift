import { useState, useEffect } from 'react'
import { FileEntry } from '../types'

interface Props {
  rootPath: string
  onFileOpen: (path: string, name: string) => void
}

function FileTree({ rootPath, onFileOpen }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadDir(rootPath)
  }, [rootPath])

  const loadDir = async (path: string) => {
    const items = await window.electronAPI.readDir(path)
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })
    setEntries(items)
  }

  const toggleDir = async (path: string) => {
    const newExpanded = new Set(expandedDirs)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
      await loadDir(path)
    }
    setExpandedDirs(newExpanded)
  }

  const getFileIcon = (name: string, isDir: boolean) => {
    if (isDir) return '📁'
    if (name.endsWith('.json')) return '{ }'
    if (name.endsWith('.yaml') || name.endsWith('.yml')) return '⚙️'
    if (name.endsWith('.jinja') || name.endsWith('.j2')) return '📝'
    if (name.endsWith('.js')) return 'JS'
    if (name.endsWith('.csv')) return '📊'
    return '📄'
  }

  const renderEntry = (entry: FileEntry, depth: number) => {
    const isExpanded = expandedDirs.has(entry.path)

    return (
      <div key={entry.path}>
        <div
          className={`file-item ${entry.isDirectory ? 'directory' : ''}`}
          style={{ paddingLeft: `${depth * 16 + 10}px` }}
          onClick={() => {
            if (entry.isDirectory) {
              toggleDir(entry.path)
            } else {
              onFileOpen(entry.path, entry.name)
            }
          }}
        >
          <span>{getFileIcon(entry.name, entry.isDirectory)}</span>
          <span>{entry.name}</span>
        </div>
        {isExpanded && entry.isDirectory && (
          entries
            .filter(e => e.path.startsWith(entry.path))
            .reduce((acc: FileEntry[], item) => {
              const relPath = item.path.replace(entry.path + '/', '')
              if (!relPath.includes('/')) {
                acc.push(item)
              }
              return acc
            }, [])
            .map(child => renderEntry(child, depth + 1))
        )}
      </div>
    )
  }

  return (
    <div className="file-tree">
      {entries.map(entry => renderEntry(entry, 0))}
    </div>
  )
}

export default FileTree
