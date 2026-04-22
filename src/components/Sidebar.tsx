import { FolderOpen, Code2, Zap, Database, GitBranch, BrainCircuit, ChevronRight, ChevronDown } from 'lucide-react';
import { useStore } from '../lib/store';

const navItems = [
  { id: 'explorer' as const, label: 'Explorer', icon: FolderOpen },
  { id: 'inference' as const, label: 'Bulk Inference', icon: Zap },
  { id: 'javascript' as const, label: 'JS Actions', icon: Code2 },
  { id: 'collections' as const, label: 'Collections', icon: Database },
  { id: 'pipelines' as const, label: 'Pipelines', icon: GitBranch },
  { id: 'agents' as const, label: 'Agents', icon: BrainCircuit },
];

export default function Sidebar() {
  const { activeView, setActiveView, sidebarOpen, toggleSidebar } = useStore();

  return (
    <div className={`flex flex-col bg-bg-secondary border-r border-border transition-all duration-200 ${sidebarOpen ? 'w-56' : 'w-12'}`}>
      <button
        onClick={toggleSidebar}
        className="p-3 hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
        title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      >
        {sidebarOpen ? (
          <ChevronRight className="w-4 h-4 rotate-180" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
      </button>

      {sidebarOpen && (
        <>
          <div className="px-3 py-2">
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Nightshift</h2>
          </div>

          <nav className="flex-1 px-2 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveView(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? 'bg-accent-dim text-accent'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="px-3 py-2 border-t border-border">
            <p className="text-xs text-text-muted">v0.1.0</p>
          </div>
        </>
      )}

      {!sidebarOpen && (
        <nav className="flex flex-col items-center gap-1 px-1 mt-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                className={`p-2 rounded-md transition-colors ${
                  isActive
                    ? 'bg-accent-dim text-accent'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'
                }`}
                title={item.label}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
