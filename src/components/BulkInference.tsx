import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play, Settings2, Download, Loader2, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';

interface JobConfig {
  name: string;
  templatePath: string;
  inputFiles: string[];
  samplingStrategy: 'single' | 'random' | 'exhaustive';
  sampleSize: number;
  providerUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  thinkingBudget: number;
  outputFormat: 'unstructured' | 'json' | 'schema-validated';
  schemaPath: string;
}

export default function BulkInference() {
  const [config, setConfig] = useState<JobConfig>({
    name: '',
    templatePath: '',
    inputFiles: [],
    samplingStrategy: 'single',
    sampleSize: 10,
    providerUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 2048,
    thinkingBudget: 0,
    outputFormat: 'unstructured',
    schemaPath: '',
  });

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [results, setResults] = useState<Array<{ status: string; prompt?: string; response?: string; error?: string }>>([]);

  async function handleRun() {
    if (!config.name || !config.templatePath) return;
    
    setIsRunning(true);
    setProgress({ current: 0, total: config.sampleSize });
    setResults([]);

    try {
      // Read template file
      const template = await invoke<string>('read_file', { path: config.templatePath });
      
      // Simulate processing (in production, this would read input files and make API calls)
      for (let i = 0; i < config.sampleSize; i++) {
        setProgress({ current: i + 1, total: config.sampleSize });
        
        const result = await invoke<Record<string, unknown>>('call_llm', {
          url: config.providerUrl,
          model: config.model,
          messages: [{ role: 'user' as const, content: template }],
          temperature: config.temperature,
          max_tokens: config.maxTokens,
        });

        setResults(prev => [...prev, {
          status: result.status === 200 ? 'completed' : 'errored',
          response: JSON.stringify(result),
        }]);
      }
    } catch (err) {
      console.error('Job failed:', err);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">Bulk Inference</h1>
      
      {/* Configuration */}
      <div className="bg-bg-secondary rounded-lg border border-border p-5 space-y-5">
        <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Settings2 className="w-4 h-4" />
          Job Configuration
        </h2>

        {/* Template */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Template File</label>
          <input
            type="text"
            value={config.templatePath}
            onChange={(e) => setConfig({ ...config, templatePath: e.target.value })}
            placeholder="/path/to/prompt.jinja2"
            className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>

        {/* Input Files */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Input Files (CSV/JSON/JSONL)</label>
          <input
            type="text"
            value={config.inputFiles.join(', ')}
            onChange={(e) => setConfig({ ...config, inputFiles: e.target.value.split(',').map(s => s.trim()) })}
            placeholder="/path/to/data.csv"
            className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>

        {/* Sampling Strategy */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-text-secondary">Sampling Strategy</label>
            <select
              value={config.samplingStrategy}
              onChange={(e) => setConfig({ ...config, samplingStrategy: e.target.value as any })}
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="single">Single</option>
              <option value="random">Random</option>
              <option value="exhaustive">Exhaustive</option>
            </select>
          </div>

          {(config.samplingStrategy === 'random' || config.samplingStrategy === 'exhaustive') && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Sample Size</label>
              <input
                type="number"
                value={config.sampleSize}
                onChange={(e) => setConfig({ ...config, sampleSize: parseInt(e.target.value) || 10 })}
                min={1}
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
              />
            </div>
          )}
        </div>

        {/* Provider Settings */}
        <div className="border-t border-border pt-4">
          <h3 className="text-xs font-medium text-text-secondary mb-3">Provider & Model</h3>
          
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="text-xs text-text-muted">API URL (OpenAI-compatible)</label>
              <input
                type="url"
                value={config.providerUrl}
                onChange={(e) => setConfig({ ...config, providerUrl: e.target.value })}
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <label className="text-xs text-text-muted">Model</label>
                <input
                  type="text"
                  value={config.model}
                  onChange={(e) => setConfig({ ...config, model: e.target.value })}
                  className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-text-muted">Temperature</label>
                <input
                  type="number"
                  value={config.temperature}
                  onChange={(e) => setConfig({ ...config, temperature: parseFloat(e.target.value) || 0 })}
                  min={0} max={2} step={0.1}
                  className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-text-muted">Max Tokens</label>
                <input
                  type="number"
                  value={config.maxTokens}
                  onChange={(e) => setConfig({ ...config, maxTokens: parseInt(e.target.value) || 0 })}
                  min={1}
                  className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-text-muted">Thinking Budget (tokens)</label>
              <input
                type="number"
                value={config.thinkingBudget}
                onChange={(e) => setConfig({ ...config, thinkingBudget: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
              />
            </div>
          </div>
        </div>

        {/* Output Format */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Output Format</label>
          <select
            value={config.outputFormat}
            onChange={(e) => setConfig({ ...config, outputFormat: e.target.value as any })}
            className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
          >
            <option value="unstructured">Unstructured</option>
            <option value="json">Plain JSON</option>
            <option value="schema-validated">Schema Validated</option>
          </select>
        </div>

        {/* Run Button */}
        <button
          onClick={handleRun}
          disabled={isRunning || !config.name || !config.templatePath}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-accent hover:bg-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run Job
            </>
          )}
        </button>
      </div>

      {/* Progress */}
      {progress && (
        <div className="mt-5 bg-bg-secondary rounded-lg border border-border p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-text-secondary">Progress</span>
            <span className="text-sm font-mono text-accent">{progress.current}/{progress.total}</span>
          </div>
          <div className="w-full h-2 bg-bg-primary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300 rounded-full"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="mt-5 space-y-3">
          <h2 className="text-sm font-medium text-text-secondary flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Results ({results.filter(r => r.status === 'completed').length}/{results.length})
          </h2>
          
          {results.map((result, i) => (
            <div key={i} className={`bg-bg-secondary rounded-lg border p-3 ${result.status === 'errored' ? 'border-error/50' : 'border-border'}`}>
              <div className="flex items-center gap-2 mb-2">
                {result.status === 'completed' ? (
                  <CheckCircle2 className="w-4 h-4 text-success" />
                ) : result.status === 'errored' ? (
                  <AlertCircle className="w-4 h-4 text-error" />
                ) : (
                  <Loader2 className="w-4 h-4 animate-spin text-accent" />
                )}
                <span className="text-sm font-mono">Sample #{i + 1}</span>
              </div>
              
              {result.prompt && (
                <details className="mt-2">
                  <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">View Prompt</summary>
                  <pre className="mt-1 p-2 bg-bg-primary rounded text-xs text-text-secondary overflow-x-auto whitespace-pre-wrap">{result.prompt}</pre>
                </details>
              )}

              {result.response && (
                <details className="mt-2">
                  <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">View Response</summary>
                  <pre className="mt-1 p-2 bg-bg-primary rounded text-xs text-text-secondary overflow-x-auto whitespace-pre-wrap">{result.response}</pre>
                </details>
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
