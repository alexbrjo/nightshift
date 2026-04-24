import { useState, useEffect, useCallback, useRef } from 'react'

interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

interface FileTreeNode extends FileInfo {
  children?: FileTreeNode[]
  expanded?: boolean
}

export default function FileTree({ projectPath, onFileSelect }: { projectPath: string; onFileSelect?: (path: string) => void }): JSX.Element {
  const [nodes, setNodes] = useState<FileTreeNode[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  const loadDirectory = useCallback(async (path: string): Promise<void> => {
    if (cancelledRef.current) return
    setLoading(true)
    setError(null)
    try {
      const items = await window.nightshift.fs.listDirectory(projectPath, path)
      if (!cancelledRef.current) {
        setNodes(items.map(item => ({
          ...item,
          children: item.isDirectory ? [] : undefined,
          expanded: false,
        })))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Failed to load directory:', projectPath, path, err)
      if (!cancelledRef.current) {
        setError(`Failed to list directory: ${message}`)
        setNodes([])
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false)
      }
    }
  }, [projectPath])

  useEffect(() => {
    cancelledRef.current = false
    loadDirectory('')
    return () => { cancelledRef.current = true }
  }, [projectPath, loadDirectory])

  const handleItemClick = useCallback(async (node: FileTreeNode): Promise<void> => {
    if (node.isDirectory) {
      setNodes(prev => prev.map(n =>
        n.path === node.path ? { ...n, expanded: !n.expanded } : n
      ))

      // Load children if expanding and not yet loaded
      if (!node.expanded && (!node.children || node.children.length === 0)) {
        try {
          const items = await window.nightshift.fs.listDirectory(projectPath, node.path)
          setNodes(prev => prev.map(n =>
            n.path === node.path ? { ...n, children: items.map(i => ({ ...i, children: i.isDirectory ? [] : undefined, expanded: false })), expanded: true } : n
          ))
        } catch (err) {
          console.error('Failed to load subdirectory:', err)
        }
      }
    } else {
      setActiveFile(node.path)
      onFileSelect?.(node.path)
    }
  }, [projectPath, onFileSelect])

  const renderNode = (node: FileTreeNode, depth: number): JSX.Element => (
    <div key={node.path}>
      <div
        className={`tree-item ${activeFile === node.path ? 'active' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => handleItemClick(node)}
      >
        {node.isDirectory && (
          <span style={{ width: 14, display: 'inline-block', textAlign: 'center' }}>
            {node.expanded ? '▼' : '▶'}
          </span>
        )}
        {!node.isDirectory && <span style={{ width: 14 }} />}
        <span>{node.isDirectory ? '📁' : getFileIcon(node.name)}</span>
        <span>{node.name}</span>
      </div>
      {node.expanded && node.children?.map(child => renderNode(child, depth + 1))}
    </div>
  )

  return (
    <div className="file-tree">
      {loading ? (
        <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>Loading...</div>
      ) : error ? (
        <div style={{ padding: '8px', fontSize: '12px', color: 'var(--accent-red)' }}>{error}</div>
      ) : nodes.length === 0 ? (
        <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>No files found</div>
      ) : (
        nodes.map(node => renderNode(node, 0))
      )}
    </div>
  )
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const icons: Record<string, string> = {
    js: '📜', jsx: '⚛️', ts: '📘', tsx: '⚛️',
    json: '📋', jsonl: '📊', csv: '📈',
    yaml: '⚙️', yml: '⚙️',
    jinja: '🎨', jinja2: '🎨', tmpl: '🎨',
  }
  return icons[ext] || '📄'
}
