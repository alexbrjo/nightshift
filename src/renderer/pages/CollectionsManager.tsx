import { useState, useEffect, useCallback } from 'react'

interface CollectionItem {
  _id: string
  _createdAt: number
  [key: string]: unknown
}

export default function CollectionsManager({ projectPath }: { projectPath: string }): JSX.Element {
  const [collections, setCollections] = useState<string[]>([])
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null)
  const [items, setItems] = useState<CollectionItem[]>([])
  const [totalItems, setTotalItems] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadCollections()
  }, [])

  useEffect(() => {
    if (selectedCollection) {
      loadItems(selectedCollection, currentPage, searchQuery)
    }
  }, [selectedCollection, currentPage, searchQuery])

  const loadCollections = useCallback(async (): Promise<void> => {
    try {
      const names = await window.nightshift.project.getCollections(projectPath)
      setCollections(names)
    } catch (err) {
      console.error('Failed to load collections:', err)
    }
  }, [projectPath])

  const loadItems = useCallback(async (collectionName: string, page: number, query: string): Promise<void> => {
    setLoading(true)
    try {
      let result: { items: CollectionItem[]; total: number }
      if (query.trim()) {
        const searchResult = await window.nightshift.collection.search(projectPath, collectionName, query, page, 50)
        result = { items: searchResult.items as unknown as CollectionItem[], total: searchResult.total }
      } else {
        const getResult = await window.nightshift.collection.getItems(projectPath, collectionName, page, 50)
        result = { items: getResult.items as unknown as CollectionItem[], total: getResult.total }
      }
      setItems(result.items)
      setTotalItems(result.total)
    } catch (err) {
      console.error('Failed to load items:', err)
      setItems([])
      setTotalItems(0)
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  const handleDeleteItem = useCallback(async (itemId: string): Promise<void> => {
    if (!selectedCollection || !confirm('Delete this item?')) return

    try {
      await window.nightshift.collection.deleteItem(projectPath, selectedCollection, itemId)
      loadItems(selectedCollection, currentPage, searchQuery)
    } catch (err) {
      console.error('Failed to delete item:', err)
    }
  }, [selectedCollection, projectPath, currentPage, searchQuery, loadItems])

  const handleExport = useCallback(async (format: 'jsonl' | 'csv'): Promise<void> => {
    if (!selectedCollection) return

    try {
      let content: string
      if (format === 'jsonl') {
        content = await window.nightshift.collection.exportJsonl(projectPath, selectedCollection)
      } else {
        content = await window.nightshift.collection.exportCsv(projectPath, selectedCollection)
      }

      const blob = new Blob([content], { type: format === 'jsonl' ? 'application/x-ndjson' : 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${selectedCollection}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error(`Failed to export as ${format}:`, err)
    }
  }, [selectedCollection, projectPath])

  const totalPages = Math.ceil(totalItems / 50)
  const columns = items.length > 0 ? Object.keys(items[0]).filter(k => !k.startsWith('_')) : []

  return (
    <div style={{ maxWidth: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2>Collections</h2>
        {selectedCollection && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => handleExport('jsonl')}>Export JSONL</button>
            <button className="btn btn-sm" onClick={() => handleExport('csv')}>Export CSV</button>
          </div>
        )}
      </div>

      {/* Collection list */}
      {collections.length > 0 ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {collections.map(name => (
              <button
                key={name}
                className={`btn ${selectedCollection === name ? 'btn-primary' : ''}`}
                onClick={() => { setSelectedCollection(name); setCurrentPage(1) }}
              >
                {name} ({totalItems})
              </button>
            ))}
          </div>

          {/* Search */}
          {selectedCollection && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                className="form-input"
                placeholder={`Search in ${selectedCollection}...`}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ maxWidth: 300 }}
              />
            </div>
          )}

          {/* Items table */}
          {selectedCollection && (
            <>
              <div className="collection-table-wrapper" style={{ maxHeight: '500px', overflowY: 'auto' }}>
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {columns.map(col => (
                        <th key={col}>{col}</th>
                      ))}
                      <th style={{ width: 60 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={columns.length + 2} style={{ textAlign: 'center', padding: 20 }}>Loading...</td></tr>
                    ) : items.length === 0 ? (
                      <tr><td colSpan={columns.length + 2} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>No items found</td></tr>
                    ) : (
                      items.map((item, i) => (
                        <tr key={item._id}>
                          <td>{(currentPage - 1) * 50 + i + 1}</td>
                          {columns.map(col => (
                            <td key={col} title={String(item[col] ?? '')}>
                              {typeof item[col] === 'object' ? JSON.stringify(item[col]) : String(item[col] ?? '')}
                            </td>
                          ))}
                          <td>
                            <button className="btn btn-sm btn-danger" onClick={() => handleDeleteItem(item._id)}>Del</button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="pagination">
                  <button className="btn btn-sm" disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>← Prev</button>
                  <span className="page-info">Page {currentPage} of {totalPages}</span>
                  <button className="btn btn-sm" disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)}>Next →</button>
                </div>
              )}

              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                {totalItems} total items · Showing 50 per page
              </div>
            </>
          )}
        </>
      ) : (
        <div className="not-implemented">No collections yet. Run an inference job to create one.</div>
      )}
    </div>
  )
}
