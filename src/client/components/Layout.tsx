import { Outlet, Link } from 'react-router-dom';
import { FolderOpen, Cpu, Database, GitBranch, Bot, Zap } from 'lucide-react';

export default function Layout() {
  return (
    <div className="flex h-screen">
      <aside className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col">
        <div className="p-4 font-bold text-lg">Nightshift</div>
        <nav className="flex-1 px-2 space-y-1">
          <Link to="/" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-700">
            <FolderOpen size={18} /> Project
          </Link>
          <Link to="/jobs" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-700">
            <Cpu size={18} /> Jobs
          </Link>
          <Link to="/collections" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-700">
            <Database size={18} /> Collections
          </Link>
          <Link to="/actions" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-700">
            <Zap size={18} /> Actions
          </Link>
          <Link to="/pipelines" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-700">
            <GitBranch size={18} /> Pipelines
          </Link>
          <Link to="/agents" className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-700">
            <Bot size={18} /> Agents
          </Link>
        </nav>
      </aside>
      <main className="flex-1 overflow-auto bg-gray-900 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
}
