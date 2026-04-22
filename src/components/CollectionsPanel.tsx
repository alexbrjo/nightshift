import { useState } from 'react'
import { useProjectStore } from '../store/project'
import CollectionTable from './CollectionTable'

export default function CollectionsPanel() {
  const { collections } = useProjectStore()
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null)
  
  return (
    <div className="flex h-full">
      {!selectedCollection ? (
        <div className="w-64 border-r border-gray-700 p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Collections</h2>
            <button className="px-3 py-1 bg-primary-600 hover:bg-primary-700 rounded text-sm">
              +
            </button>
          </div>
          
          {collections.length === 0 ? (
            <p className="text-gray-500 text-sm">No collections yet</p>
          ) : (
            <div className="space-y-2">
              {collections.map((collection) => (
                <div
                  key={collection.id}
                  onClick={() => setSelectedCollection(collection.id)}
                  className={`p-3 rounded cursor-pointer ${
                    selectedCollection === collection.id ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-750'
                  }`}
                >
                  <div className="font-medium">{collection.name}</div>
                  <div className="text-sm text-gray-400">
                    {collection.item_count} items
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      
      <div className={`flex-1 ${!selectedCollection ? 'flex items-center justify-center text-gray-500' : ''}`}>
        {selectedCollection ? (
          <CollectionTable collectionId={parseInt(selectedCollection)} />
        ) : (
          <p>Select a collection to view items</p>
        )}
      </div>
    </div>
  )
}
