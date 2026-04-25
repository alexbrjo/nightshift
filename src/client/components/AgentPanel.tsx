import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface Agent {
  id: string;
  name: string;
  status: string;
  config: { queries?: string[]; targetCollection?: string };
  createdAt: string;
}

export default function AgentPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [queries, setQueries] = useState('');
  const [targetCollection, setTargetCollection] = useState('');
  const [analysis, setAnalysis] = useState<string | null>(null);

  const fetchAgents = () => {
    api
      .getAgents()
      .then((res) => {
        const list = (res.agents as any[]).map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          config: a.config || {},
          createdAt: a.createdAt,
        })) as Agent[];
        setAgents(list);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    fetchAgents();
    api
      .readFile('analysis.md')
      .then((res) => setAnalysis(res.content))
      .catch(() => setAnalysis(null));
  }, []);

  const handleSave = async () => {
    try {
      const config = {
        name,
        queries: queries
          .split('\n')
          .map((q) => q.trim())
          .filter(Boolean),
        targetCollection: targetCollection || undefined,
      };
      await api.createAgent(config);
      setCreating(false);
      setName('');
      setQueries('');
      setTargetCollection('');
      fetchAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create agent');
    }
  };

  const handleRun = async (id: string) => {
    try {
      await api.runAgent(id);
      fetchAgents();
      api
        .readFile('analysis.md')
        .then((res) => setAnalysis(res.content))
        .catch(() => setAnalysis(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run agent');
    }
  };

  const exportFindings = (agent: Agent) => {
    const data = {
      ...agent,
      analysis: analysis || null,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-${agent.name}-findings.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold">Agents</h1>
      {error && (
        <div className="p-3 bg-red-900/20 text-red-400 rounded text-sm">{error}</div>
      )}

      {analysis !== null && (
        <div className="bg-gray-800 p-4 rounded border border-gray-700">
          <div className="text-xs text-gray-400 mb-2">analysis.md</div>
          <pre className="bg-gray-900 p-3 rounded text-xs overflow-auto max-h-60 border border-gray-700">
            {analysis}
          </pre>
        </div>
      )}

      {!creating ? (
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 bg-blue-600 rounded text-sm font-medium hover:bg-blue-500"
        >
          Create Agent
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
          <div>
            <label className="block text-xs text-gray-400 mb-1">Queries (one per line)</label>
            <textarea
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm h-32"
              value={queries}
              onChange={(e) => setQueries(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Target Collection (optional)</label>
            <input
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
              value={targetCollection}
              onChange={(e) => setTargetCollection(e.target.value)}
            />
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
                setQueries('');
                setTargetCollection('');
              }}
              className="px-4 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="p-4 bg-gray-800 rounded border border-gray-700 flex items-center justify-between"
          >
            <div>
              <div className="font-medium">{agent.name}</div>
              <div className="text-xs text-gray-500">
                Status: <span className="text-gray-300">{agent.status}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleRun(agent.id)}
                className="px-3 py-1 bg-blue-600 rounded text-sm hover:bg-blue-500"
              >
                Run
              </button>
              <button
                onClick={() => exportFindings(agent)}
                className="px-3 py-1 bg-gray-700 rounded text-sm hover:bg-gray-600"
              >
                Export Findings
              </button>
            </div>
          </div>
        ))}
        {agents.length === 0 && (
          <div className="text-gray-500 text-sm">No agents yet.</div>
        )}
      </div>
    </div>
  );
}
