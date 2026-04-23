import { useState, useEffect } from 'react'
import type { Collection } from '../types'

interface Props {
  projectPath: string
  onItemOpen: (id: string) => void
  onCreate: () => void
}

function CollectionsView({ projectPath, onItemOpen }: Props) {
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadCollections()
  }, [projectPath])

  const loadCollections = async () => {
    try {
      const dir = await window.electronAPI.readDir(projectPath)
      const colls = dir
        .filter(e => e.name.endsWith('.collection.json'))
        .map(async (e) => {
          const content = await window.electronAPI.readFile(e.path)
          if (content) {
            try {
              return JSON.parse(content) as Collection
            } catch {
              return null
            }
          }
          return null
        })
      const results = await Promise.all(colls)
      setCollections(results.filter(Boolean) as Collection[])
    } catch (err) {
      console.error('Failed to load collections:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div>Loading...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Collections</h3>
        <button className="btn btn-primary" onClick={onCreate}>+ New</button>
      </div>
      {collections.length === 0 ? (
        <p style={{ color: '#8b949e' }}>No collections yet. Run a bulk inference job to create one.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {collections.map(c => (
            <div
              key={c.id}
              onClick={() => onItemOpen(c.id)}
              style={{
                padding: 12,
                background: '#21262d',
                borderRadius: 6,
                cursor: 'pointer'
              }}
            >
              <div style={{ fontWeight: 500 }}>{c.name}</div>
              <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>
                {c.items.length} items • Created {new Date(c.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default CollectionsView
