import { useState, useEffect } from 'react';
import axios from 'axios';
export default function CollectionsPage() {
    const [collections, setCollections] = useState([]);
    const [loading, setLoading] = useState(true);
    const [projectId] = useState(null);
    useEffect(() => {
        fetchCollections();
    }, []);
    async function fetchCollections() {
        try {
            const response = await axios.get('http://localhost:8000/api/collections');
            setCollections(response.data);
        }
        catch (error) {
            console.error('Failed to fetch collections:', error);
        }
        finally {
            setLoading(false);
        }
    }
    async function handleCreateCollection() {
        const name = prompt('Enter collection name:');
        if (!name)
            return;
        try {
            await axios.post('http://localhost:8000/api/collections', {
                project_id: projectId || 1,
                name,
            });
            fetchCollections();
        }
        catch (error) {
            console.error('Failed to create collection:', error);
            alert('Error creating collection');
        }
    }
    if (loading) {
        return <div style={{ padding: '24px' }}>Loading...</div>;
    }
    return (<div className="collections-page">
      <div className="page-header">
        <h1>Collections</h1>
        <button className="btn-primary" onClick={handleCreateCollection}>
          New Collection
        </button>
      </div>

      {collections.length === 0 ? (<div className="empty-state">
          <p>No collections yet. Create one to store job outputs.</p>
        </div>) : (<div className="collection-list">
          {collections.map((collection) => (<div key={collection.id} className="card">
              <h3>{collection.name}</h3>
              <span>{collection.description || 'No description'}</span>
            </div>))}
        </div>)}
    </div>);
}
