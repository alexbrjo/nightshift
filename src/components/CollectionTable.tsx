import { useState } from 'react'

interface CollectionItem {
  id: number
  data: Record<string, any>
}

interface CollectionTableProps {
  collectionId: number
}

export default function CollectionTable({ collectionId }: CollectionTableProps) {
  const [items] = useState<CollectionItem[]>([])
  const [page, setPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const pageSize = 50
  
  const totalPages = Math.ceil(items.length / pageSize)
  const startIndex = (page - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedItems = items.slice(startIndex, endIndex)
  
  // Detect columns from first item
  const columns = items.length > 0 ? Object.keys(items[0].data) : []
  
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700 flex items-center gap-4">
        <input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm focus:outline-none focus:border-primary-500"
        />
        
        <div className="flex-1" />
        
        <button className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm">
          Delete Selected
        </button>
        <button className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 rounded text-sm">
          Export JSONL
        </button>
        <button className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 rounded text-sm">
          Export CSV
        </button>
      </div>
      
      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          <p>No items in this collection</p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left border-b border-gray-700">#</th>
                  {columns.map((col) => (
                    <th key={col} className="px-4 py-2 text-left border-b border-gray-700">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginatedItems.map((item, idx) => (
                  <tr key={item.id} className="border-b border-gray-800 hover:bg-gray-800">
                    <td className="px-4 py-2 text-gray-500">{startIndex + idx + 1}</td>
                    {columns.map((col) => (
                      <td key={col} className="px-4 py-2 truncate max-w-xs">
                        {typeof item.data[col] === 'object' 
                          ? JSON.stringify(item.data[col]) 
                          : String(item.data[col] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          <div className="p-4 border-t border-gray-700 flex items-center justify-between">
            <span className="text-sm text-gray-400">
              Showing {startIndex + 1}-{Math.min(endIndex, items.length)} of {items.length}
            </span>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm">
                Page {page} of {totalPages || 1}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
