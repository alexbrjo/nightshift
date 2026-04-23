import { useState, useEffect } from 'react';
import axios from 'axios';
export default function ProjectsPage() {
    const [projects, setProjects] = useState([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchProjects();
    }, []);
    async function fetchProjects() {
        try {
            const response = await axios.get('http://localhost:8000/api/projects');
            setProjects(response.data);
        }
        catch (error) {
            console.error('Failed to fetch projects:', error);
        }
        finally {
            setLoading(false);
        }
    }
    async function handleCreateProject() {
        const name = prompt('Enter project name:');
        if (!name)
            return;
        const path = prompt('Enter directory path:', './data');
        if (!path)
            return;
        try {
            await axios.post('http://localhost:8000/api/projects', {
                name,
                path,
                description: '',
            });
            fetchProjects();
        }
        catch (error) {
            console.error('Failed to create project:', error);
            alert('Error creating project');
        }
    }
    if (loading) {
        return <div style={{ padding: '24px' }}>Loading...</div>;
    }
    return (<div className="projects-page">
      <div className="page-header">
        <h1>Projects</h1>
        <button className="btn-primary" onClick={handleCreateProject}>
          New Project
        </button>
      </div>

      {projects.length === 0 ? (<div className="empty-state">
          <p>No projects yet. Create one to get started.</p>
        </div>) : (<div className="project-grid">
          {projects.map((project) => (<a key={project.id} href={`/jobs?projectId=${project.id}`} className="card">
              <h3>{project.name}</h3>
              <p>{project.description || 'No description'}</p>
              <div className="card-footer">
                <span>{project.path}</span>
              </div>
            </a>))}
        </div>)}
    </div>);
}
