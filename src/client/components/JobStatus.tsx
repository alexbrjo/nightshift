import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { Job, Sample } from '@shared/types';

export default function JobStatus() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [selectedSample, setSelectedSample] = useState<Sample | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    api.getJob(id)
      .then(res => {
        setJob(res.job as Job);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load job'));

    const unsubscribe = api.subscribeJob(id, (data: unknown) => {
      const msg = data as { type: string; sample?: Sample; samples?: Sample[] };
      if (msg.type === 'init' && msg.samples) {
        setSamples(msg.samples);
      } else if (msg.type === 'update' && msg.sample) {
        setSamples(prev => {
          const exists = prev.find(s => s.id === msg.sample!.id);
          if (exists) {
            return prev.map(s => s.id === msg.sample!.id ? msg.sample! : s);
          }
          return [...prev, msg.sample!];
        });
      } else if (msg.sample) {
        setSamples(prev => {
          const exists = prev.find(s => s.id === msg.sample!.id);
          if (exists) {
            return prev.map(s => s.id === msg.sample!.id ? msg.sample! : s);
          }
          return [...prev, msg.sample!];
        });
      }
    });

    return () => unsubscribe();
  }, [id]);

  const statusClass = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-gray-700 text-gray-300';
      case 'streaming': return 'bg-blue-900/30 text-blue-400';
      case 'completed': return 'bg-green-900/30 text-green-400';
      case 'error': return 'bg-red-900/30 text-red-400';
      default: return 'bg-gray-700 text-gray-300';
    }
  };

  const exportYaml = async () => {
    if (!id) return;
    const res = await api.exportJobYaml(id);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-${id}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!id) return <div className="p-6">Invalid job ID</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{job?.name || 'Job'}</h1>
          <div className="text-sm text-gray-400 mt-1">Status: <span className={statusClass(job?.status || '')}>{job?.status}</span></div>
        </div>
        <button onClick={exportYaml} className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600">Export YAML</button>
      </div>
      {error && <div className="p-3 bg-red-900/20 text-red-400 rounded text-sm">{error}</div>}

      <div className="overflow-auto">
        <table className="w-full text-sm border border-gray-700 rounded">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              <th className="text-left px-3 py-2">ID</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Latency</th>
              <th className="text-left px-3 py-2">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {samples.map(sample => (
              <React.Fragment key={sample.id}>
                <tr onClick={() => setSelectedSample(selectedSample?.id === sample.id ? null : sample)} className="hover:bg-gray-800 cursor-pointer">
                  <td className="px-3 py-2 font-mono text-xs">{sample.id}</td>
                  <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded ${statusClass(sample.status)}`}>{sample.status}</span></td>
                  <td className="px-3 py-2">{sample.latencyMs ? `${sample.latencyMs}ms` : '-'}</td>
                  <td className="px-3 py-2">{sample.tokens ?? '-'}</td>
                </tr>
                {selectedSample?.id === sample.id && (
                  <tr>
                    <td colSpan={4} className="px-3 py-3 bg-gray-800/50">
                      <div className="space-y-3">
                        <div>
                          <div className="text-xs font-semibold text-gray-400 mb-1">Prompt</div>
                          <pre className="bg-gray-900 p-2 rounded text-xs overflow-auto max-h-48 border border-gray-700">{sample.prompt}</pre>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-gray-400 mb-1">Response</div>
                          <pre className="bg-gray-900 p-2 rounded text-xs overflow-auto max-h-48 border border-gray-700">{sample.response || sample.error || 'N/A'}</pre>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {samples.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-gray-500">No samples yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
