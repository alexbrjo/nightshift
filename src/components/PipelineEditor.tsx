import { useState, useRef } from 'react';
import { GitBranch, Plus, Play, Trash2, Settings2, Save, Download, Upload } from 'lucide-react';

interface PipelineStage {
  id: string;
  name: string;
  type: 'inference' | 'javascript' | 'filter' | 'transform';
  position: { x: number; y: number };
}

interface PipelineConnection {
  id: string;
  fromStageId: string;
  toStageId: string;
}

const stageTypes = [
  { value: 'inference', label: 'Inference', color: 'bg-accent' },
  { value: 'javascript', label: 'JavaScript', color: 'bg-yellow-500' },
  { value: 'filter', label: 'Filter', color: 'bg-green-500' },
  { value: 'transform', label: 'Transform', color: 'bg-purple-500' },
];

export default function PipelineEditor() {
  const [stages, setStages] = useState<PipelineStage[]>([
    { id: '1', name: 'Stage 1', type: 'inference', position: { x: 80, y: 120 } },
    { id: '2', name: 'Stage 2', type: 'javascript', position: { x: 360, y: 120 } },
  ]);
  const [connections, setConnections] = useState<PipelineConnection[]>([
    { id: 'c1', fromStageId: '1', toStageId: '2' },
  ]);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  function addStage(type: PipelineStage['type']) {
    const id = `stage-${Date.now()}`;
    const x = 80 + (stages.length % 3) * 280;
    const y = 120 + Math.floor(stages.length / 3) * 160;
    
    setStages(prev => [...prev, { id, name: `Stage ${prev.length + 1}`, type, position: { x, y } }]);
  }

  function removeStage(id: string) {
    setStages(prev => prev.filter(s => s.id !== id));
    setConnections(prev => prev.filter(c => c.fromStageId !== id && c.toStageId !== id));
  }

  function handleRun(trial = false) {
    setIsRunning(true);
    console.log(`Running pipeline${trial ? ' (trial)' : ''}...`);
    setTimeout(() => setIsRunning(false), 2000);
  }

  function exportYaml() {
    const yaml = stages.map(s => `  - name: ${s.name}\n    type: ${s.type}`).join('\n');
    console.log('Pipeline YAML:', yaml);
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-bg-secondary border-b border-border">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold flex items-center gap-2">
            <GitBranch className="w-4 h-4" />
            Experiment Pipelines
          </h1>

          <button
            onClick={() => handleRun(true)}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-warning/10 text-warning hover:bg-warning/20 transition-colors disabled:opacity-50"
          >
            <Play className="w-3 h-3" />
            Trial Run
          </button>

          <button
            onClick={() => handleRun(false)}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-accent hover:bg-accent-hover text-white transition-colors disabled:opacity-50"
          >
            <Play className="w-3 h-3" />
            Run Full Pipeline
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={exportYaml} className="p-1.5 rounded hover:bg-bg-hover text-text-muted transition-colors" title="Export YAML">
            <Download className="w-4 h-4" />
          </button>
          <button className="p-1.5 rounded hover:bg-bg-hover text-text-muted transition-colors" title="Import Pipeline">
            <Upload className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex flex-1 overflow-hidden">
        {/* Stage palette */}
        <div className="w-48 bg-bg-secondary border-r border-border p-3">
          <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Add Stage</h3>
          <div className="space-y-2">
            {stageTypes.map(type => (
              <button
                key={type.value}
                onClick={() => addStage(type.value as PipelineStage['type'])}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm bg-bg-primary border border-border hover:border-accent transition-colors"
              >
                <span className={`w-2.5 h-2.5 rounded-full ${type.color}`} />
                {type.label}
              </button>
            ))}
          </div>

          {/* Stage list */}
          {stages.length > 0 && (
            <>
              <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mt-5 mb-3">Stages</h3>
              <div className="space-y-1">
                {stages.map(stage => {
                  const typeInfo = stageTypes.find(t => t.value === stage.type);
                  return (
                    <button
                      key={stage.id}
                      onClick={() => setSelectedStage(selectedStage === stage.id ? null : stage.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                        selectedStage === stage.id ? 'bg-accent-dim text-accent' : 'text-text-secondary hover:bg-bg-hover'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full ${typeInfo?.color}`} />
                      <span className="truncate flex-1">{stage.name}</span>
                      {stages.length > 1 && (
                        <Trash2
                          className="w-3 h-3 opacity-0 group-hover:opacity-100 hover:text-error transition-opacity"
                          onClick={(e) => { e.stopPropagation(); removeStage(stage.id); }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Canvas area */}
        <div className="flex-1 bg-bg-primary relative overflow-auto">
          {/* Grid background */}
          <div
            className="absolute inset-0 opacity-5"
            style={{
              backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }}
          />

          {/* SVG connections */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            {connections.map(conn => {
              const from = stages.find(s => s.id === conn.fromStageId);
              const to = stages.find(s => s.id === conn.toStageId);
              if (!from || !to) return null;

              const x1 = from.position.x + 200;
              const y1 = from.position.y + 40;
              const x2 = to.position.x;
              const y2 = to.position.y + 40;
              const cx = (x1 + x2) / 2;

              return (
                <path
                  key={conn.id}
                  d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#6c8cff"
                  strokeWidth="2"
                  className="pointer-events-auto cursor-pointer"
                />
              );
            })}
          </svg>

          {/* Stage nodes */}
          {stages.map(stage => {
            const typeInfo = stageTypes.find(t => t.value === stage.type);
            return (
              <div
                key={stage.id}
                className="absolute w-48 bg-bg-secondary border rounded-lg shadow-lg cursor-move"
                style={{ left: stage.position.x, top: stage.position.y }}
              >
                <div className={`h-1 rounded-t-lg ${typeInfo?.color}`} />
                <div className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-text-primary">{stage.name}</span>
                    <Settings2 className="w-3.5 h-3.5 text-text-muted hover:text-text-primary cursor-pointer" />
                  </div>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs ${typeInfo?.color}/20 text-white`}>
                    {stage.type}
                  </span>
                </div>

                {/* Connection ports */}
                <div className="absolute -left-1.5 top-8 w-3 h-3 bg-bg-primary border-2 border-accent rounded-full" />
                <div className="absolute -right-1.5 bottom-4 w-3 h-3 bg-bg-primary border-2 border-border rounded-full" />
              </div>
            );
          })}

          {stages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <GitBranch className="w-12 h-12 text-text-muted mx-auto mb-3" />
                <p className="text-sm text-text-muted">No stages yet</p>
                <p className="text-xs text-text-muted mt-1">Add a stage from the sidebar to get started</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
