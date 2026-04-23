import { Link, Outlet } from 'react-router-dom';
import './Layout.css';
export default function Layout() {
    return (<div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">Nightshift</div>
        <nav className="nav-menu">
          <Link to="/projects" className="nav-item">
            📁 Projects
          </Link>
          <Link to="/jobs" className="nav-item">
            ⚙️ Jobs
          </Link>
          <Link to="/collections" className="nav-item">
            📦 Collections
          </Link>
          <Link to="/pipelines" className="nav-item">
            🔄 Pipelines
          </Link>
          <Link to="/analyses" className="nav-item">
            📊 Analyses
          </Link>
        </nav>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>);
}
