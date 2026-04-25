import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import type { Pipeline, PipelineStage } from '@shared/types';
import yaml from 'js-yaml';

function makeId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function PipelineEditor() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [stages, setStages] = useState<PipelineStage[]>([]);

  const fetchPipelines = () => {
    api.getPipelines()
      .then((res) => {
        const list = (res.pipelines as any[]).map((p) => ({
          id: p.id,
          name: p.name,
          stages: p.stages || (p.definition?.stages ?? []),
          status: p.status,
          createdAt: p.createdAt,
          runs: p.runs || [],
        })) as Pipeline[];
        setPipelines(list);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    fetchPipelines();
  }, []);

  const addStage = () => {
    setStages((prev) => [
      ...prev,
      { id: makeId(), type: 'job', ref: '', config: {} },
    ]);
  };

  const removeStage = (index: number) => {
    setStages((prev) => prev.filter((_, i) => i !== index));
  };

  const moveStage = (index: number, dir: -1 | 1) => {
    setStages((prev) => {
      const next = [...prev];
      const newIndex = index + dir;
      if (newIndex < 0 || newIndex >= next.length) return prev;
      [next[index], next[newIndex]] = [next[newIndex], next[index]];
      return next;
    });
  };

  const updateStage = (index: number, field: keyof PipelineStage, value: unknown) => {
    setStages((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };

  const handleSave = async () => {
    try {
      const payload = { name, stages };
      await api.createPipeline(payload);
      setCreating(false);
      setName('');
      setStages([]);
      fetchPipelines();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create pipeline');
    }
  };

  const handleRun = async (id: string, trial: boolean) => {
    try {
      await api.runPipeline(id, trial);
      fetchPipelines();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run pipeline');
    }
  };

  const previewYaml = useMemo(() => {
    try {
      return yaml.dump({ name, stages });
    } catch {
      return '';
    }
  }, [name, stages]);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold">Pipelines</h1>
      {error && (
        <div className="p-3 bg-red-900/20 text-red-400 rounded text-sm">{error}</div>
      )}

      {!creating ? (
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 bg-blue-600 rounded text-sm font-medium hover:bg-blue-500"
        >
          Create Pipeline
        </button>
      ) : (
        <div className="space-y-4 bg-gray-800 p-4 rounded border border-gray-700">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <div className="text-xs text-gray-400">Stages</div>
            {stages.map((stage, index) => (
              <div
                key={stage.id}
                className="flex items-start gap-2 bg-gray-900 p-2 rounded border border-gray-700"
              >
                <div className="flex-1 space-y-2">
                  <select
                    className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm"
                    value={stage.type}
                    onChange={(e) =>
                      updateStage(index, 'type', e.target.value as PipelineStage['type'])
                    }
                  >
                    <option value="job">job</option>
                    <option value="action">action</option>
                    <option value="agent">agent</option>
                  </select>
                  <input
                    className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm"
                    placeholder="Ref (job id or file path)"
                    value={stage.ref}
                    onChange={(e) => updateStage(index, 'ref', e.target.value)}
                  />
                  <textarea
                    className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm h-20"
                    placeholder="Config JSON (optional)"
                    value={stage.config ? JSON.stringify(stage.config, null, 2) : ''}
                    onChange={(e) => {
                      try {
                        const config = e.target.value ? JSON.parse(e.target.value) : {};
                        updateStage(index, 'config', config);
                      } catch {
                        // ignore invalid JSON while typing
                      }
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => moveStage(index, -1)}
                    disabled={index === 0}
                    className="px-2 py-1 bg-gray-700 rounded text-xs hover:bg-gray-600 disabled:opacity-30"
                  >
                    Up
                  </button>
                  <button
                    onClick={() => moveStage(index, 1)}
                    disabled={index === stages.length - 1}
                    className="px-2 py-1 bg-gray-700 rounded text-xs hover:bg-gray-600 disabled:opacity-30"
                  >
                    Down
                  </button>
                  <button
                    onClick={() => removeStage(index)}
                    className="px-2 py-1 bg-red-900/30 text-red-400 rounded text-xs hover:bg-red-900/50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              onClick={addStage}
              className="px-3 py-1 bg-gray-700 rounded text-sm hover:bg-gray-600"
            >
              Add Stage
            </button>
          </div>

          <div>
            <div className="text-xs text-gray-400 mb-1">YAML Preview</div>
            <pre className="bg-gray-900 border border-gray-700 rounded p-2 text-xs overflow-auto max-h-40">
              {previewYaml}
            </pre>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 rounded text-sm font-medium hover:bg-blue-500"
            >
              Save
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setName('');
                setStages([]);
              }}
              className="px-4 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {pipelines.map((pipeline: any) => (
          <div
            key={pipeline.id}
            className="p-4 bg-gray-800 rounded border border-gray-700 space-y-3"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{pipeline.name}</div>
                <div className="text-xs text-gray-500">{pipeline.stages?.length ?? 0} stage(s)</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleRun(pipeline.id, true)}
                  className="px-3 py-1 bg-yellow-600/20 text-yellow-400 border border-yellow-600/30 rounded text-sm hover:bg-yellow-600/30"
                >
                  Run Trial
                </button>
                <button
                  onClick={() => handleRun(pipeline.id, false)}
                  className="px-3 py-1 bg-green-600/20 text-green-400 border border-green-600/30 rounded text-sm hover:bg-green-600/30"
                >
                  Run Full
                </button>
              </div>
            </div>
            <div className="text-xs text-gray-400">
              Status: <span className="text-gray-300">{pipeline.status}</span>
            </div>
            {pipeline.runs && pipeline.runs.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-gray-400">Run History</div>
                {pipeline.runs.map((run: any) => (
                  <div
                    key={run.id}
                    className="flex items-center gap-2 text-xs bg-gray-900 p-2 rounded border border-gray-700"
                  >
                    <span
                      className={`px-1.5 py-0.5 rounded ${
                        run.status === 'completed'
                          ? 'bg-green-900/30 text-green-400'
                          : run.status === 'error'
                          ? 'bg-red-900/30 text-red-400'
                          : 'bg-blue-900/30 text-blue-400'
                      }`}
                    >
                      {run.status}
                    </span>
                    <span className="text-gray-500">
                      {run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}
                    </span>
                    <span className="text-gray-500">
                      {run.completedAt ? new Date(run.completedAt).toLocaleString() : '-'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {pipelines.length === 0 && (
          <div className="text-gray-500 text-sm">No pipelines yet.</div>
        )}
      </div>
    </div>
  );
}
