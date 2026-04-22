import { useState } from 'react';
import { Code2, Play, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface JSActionConfig {
  name: string;
  scriptPath: string;
  inputFiles: string[];
}

export default function BulkJavaScript() {
  const [config, setConfig] = useState<JSActionConfig>({
    name: '',
    scriptPath: '',
    inputFiles: [],
  });

  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<Array<{ status: string; output?: string | Record<string, unknown>; error?: string }>>([]);

  async function handleRun() {
    if (!config.name || !config.scriptPath) return;
    
    setIsRunning(true);
    setResults([]);

    try {
      // In production, this would invoke the sandboxed JS executor
      const mockResult = { status: 'completed', output: { processed: 10, results: [] } };
      setResults([mockResult]);
    } catch (err) {
      console.error('JS action failed:', err);
      setResults([{ status: 'errored', error: String(err) }]);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">Bulk JavaScript Actions</h1>
      
      <div className="bg-bg-secondary rounded-lg border border-border p-5 space-y-5">
        <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Code2 className="w-4 h-4" />
          Script Configuration
        </h2>

        {/* Script */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Script File</label>
          <input
            type="text"
            value={config.scriptPath}
            onChange={(e) => setConfig({ ...config, scriptPath: e.target.value })}
            placeholder="/path/to/script.js"
            className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>

        {/* Input Files */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Input Datasets</label>
          <input
            type="text"
            value={config.inputFiles.join(', ')}
            onChange={(e) => setConfig({ ...config, inputFiles: e.target.value.split(',').map(s => s.trim()) })}
            placeholder="/path/to/data.jsonl"
            className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>

        {/* Script Preview */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Script Preview</label>
          <pre className="p-3 bg-bg-primary rounded-md border border-border text-sm text-text-secondary font-mono overflow-x-auto whitespace-pre-wrap min-h-[120px]">
{`// Example: Transform and enrich data
function process(row) {
  return {
    ...row,
    enriched: true,
    timestamp: Date.now(),
  };
}

module.exports = { process };`}
          </pre>
        </div>

        {/* Run Button */}
        <button
          onClick={handleRun}
          disabled={isRunning || !config.name || !config.scriptPath}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-accent hover:bg-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Executing...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run Script
            </>
          )}
        </button>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="mt-5 space-y-3">
          <h2 className="text-sm font-medium text-text-secondary flex items-center gap-2">
            {results[0].status === 'completed' ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4 text-error" />
            )}
            Results
          </h2>

          {results.map((result, i) => (
            <div key={i} className={`bg-bg-secondary rounded-lg border p-3 ${result.status === 'errored' ? 'border-error/50' : 'border-border'}`}>
              <div className="flex items-center gap-2 mb-2">
                {result.status === 'completed' ? (
                  <CheckCircle2 className="w-4 h-4 text-success" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-error" />
                )}
                <span className="text-sm font-mono">Execution #{i + 1}</span>
              </div>

              {'output' in result && result.output !== undefined && (
                <pre className="p-2 bg-bg-primary rounded text-xs text-text-secondary overflow-x-auto whitespace-pre-wrap">
                  {typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)}
                </pre>
              )}

              {result.error && (
                <p className="mt-2 text-sm text-error">{result.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
