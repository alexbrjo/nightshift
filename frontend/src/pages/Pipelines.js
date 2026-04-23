import { useState, useEffect } from 'react';
import axios from 'axios';
export default function PipelinesPage() {
    const [pipelines, setPipelines] = useState([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchPipelines();
    }, []);
    async function fetchPipelines() {
        try {
            const response = await axios.get('http://localhost:8000/api/pipelines');
            setPipelines(response.data);
        }
        catch (error) {
            console.error('Failed to fetch pipelines:', error);
        }
        finally {
            setLoading(false);
        }
    }
    async function handleCreatePipeline() {
        const name = prompt('Enter pipeline name:');
        if (!name)
            return;
        try {
            await axios.post('http://localhost:8000/api/pipelines', {
                project_id: 1,
                name,
                definition_yaml: '{}',
            });
            fetchPipelines();
        }
        catch (error) {
            console.error('Failed to create pipeline:', error);
            alert('Error creating pipeline');
        }
    }
    if (loading) {
        return <div style={{ padding: '24px' }}>Loading...</div>;
    }
    return (<div className="pipelines-page">
      <div className="page-header">
        <h1>Pipelines</h1>
        <button className="btn-primary" onClick={handleCreatePipeline}>
          New Pipeline
        </button>
      </div>

      {pipelines.length === 0 ? (<div className="empty-state">
          <p>No pipelines yet. Create one to define experiment workflows.</p>
        </div>) : (<div className="pipeline-list">
          {pipelines.map((pipeline) => {
                const statusColor = pipeline.status === 'running'
                    ? '#3b82f6'
                    : pipeline.status === 'completed'
                        ? '#10b981'
                        : pipeline.status === 'failed'
                            ? '#ef4444'
                            : '#f59e0b';
                return (<div key={pipeline.id} className="card">
                <div className="job-header">
                  <h3>{pipeline.name}</h3>
                  <span className="status-badge" style={{ backgroundColor: statusColor }}>
                    {pipeline.status}
                  </span>
                </div>
                <p>{pipeline.description}</p>
              </div>);
            })}
        </div>)}
    </div>);
}
