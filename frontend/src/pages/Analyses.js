import { useState, useEffect } from 'react';
import axios from 'axios';
export default function AnalysesPage() {
    const [analyses, setAnalyses] = useState([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchAnalyses();
    }, []);
    async function fetchAnalyses() {
        try {
            const response = await axios.get('http://localhost:8000/api/analyses');
            setAnalyses(response.data);
        }
        catch (error) {
            console.error('Failed to fetch analyses:', error);
        }
        finally {
            setLoading(false);
        }
    }
    async function handleCreateAnalysis() {
        const name = prompt('Enter analysis name:');
        if (!name)
            return;
        try {
            await axios.post('http://localhost:8000/api/analyses', {
                project_id: 1,
                name,
            });
            fetchAnalyses();
        }
        catch (error) {
            console.error('Failed to create analysis:', error);
            alert('Error creating analysis');
        }
    }
    if (loading) {
        return <div style={{ padding: '24px' }}>Loading...</div>;
    }
    return (<div className="analyses-page">
      <div className="page-header">
        <h1>Analyses</h1>
        <button className="btn-primary" onClick={handleCreateAnalysis}>
          New Analysis
        </button>
      </div>

      {analyses.length === 0 ? (<div className="empty-state">
          <p>No analyses yet. Create one to analyze experiment results.</p>
        </div>) : (<div className="analysis-list">
          {analyses.map((analysis) => {
                const statusColor = analysis.status === 'running'
                    ? '#3b82f6'
                    : analysis.status === 'completed'
                        ? '#10b981'
                        : analysis.status === 'failed'
                            ? '#ef4444'
                            : '#f59e0b';
                return (<div key={analysis.id} className="card">
                <div className="job-header">
                  <h3>{analysis.name}</h3>
                  <span className="status-badge" style={{ backgroundColor: statusColor }}>
                    {analysis.status}
                  </span>
                </div>
                <p>{analysis.description}</p>
              </div>);
            })}
        </div>)}
    </div>);
}
