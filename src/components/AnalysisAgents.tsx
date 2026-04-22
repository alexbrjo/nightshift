import { useState } from 'react';
import { BrainCircuit, Play, CheckCircle2, Search, FileText, MessageSquare, Eye, Save } from 'lucide-react';

type AgentStep = 'queries' | 'anecdotes' | 'summary' | 'review';

const steps: { id: AgentStep; label: string; icon: typeof Search }[] = [
  { id: 'queries', label: 'Analysis Queries', icon: Search },
  { id: 'anecdotes', label: 'Anecdotes', icon: MessageSquare },
  { id: 'summary', label: 'Summary', icon: FileText },
  { id: 'review', label: 'Review', icon: Eye },
];

export default function AnalysisAgents() {
  const [activeStep, setActiveStep] = useState<AgentStep>('queries');
  const [isRunning, setIsRunning] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [findings, setFindings] = useState('');

  async function handleRun() {
    if (!agentName) return;
    
    setIsRunning(true);
    
    // Simulate agent workflow
    for (const step of steps) {
      setActiveStep(step.id);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    setFindings(`# Analysis Report\n\n## Key Findings\n\n- Finding 1: Significant pattern detected in the data\n- Finding 2: Correlation between variables X and Y (r=0.87)\n- Finding 3: Outlier cluster identified in group B\n\n## Anecdotal Evidence\n\n"Sample quote from the data that illustrates the trend..."

## Recommendations\n\n1. Further investigation recommended for outlier cluster\n2. Consider additional controls for variable Z
3. Replicate with larger sample size`);

    setIsRunning(false);
  }

  function handleSave() {
    console.log('Saving analysis to analysis.md');
    // In production: invoke save_analysis_result Tauri command
  }

  const stepIndex = steps.findIndex(s => s.id === activeStep);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-bg-secondary">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BrainCircuit className="w-5 h-5" />
            Analysis Agents
          </h1>

          <button
            onClick={handleRun}
            disabled={isRunning || !agentName}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Run Agent
              </>
            )}
          </button>
        </div>

        {/* Agent name input */}
        <input
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="Agent name (e.g., 'Q2 Performance Analysis')"
          className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
        />

        {/* Progress steps */}
        <div className="flex items-center gap-1 mt-4">
          {steps.map((step, i) => (
            <div key={step.id} className="flex items-center flex-1 last:flex-none">
              <button
                onClick={() => !isRunning && setActiveStep(step.id)}
                disabled={isRunning}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  i === stepIndex
                    ? 'bg-accent-dim text-accent'
                    : i < stepIndex
                    ? 'text-success bg-success/10'
                    : 'text-text-muted hover:bg-bg-hover'
                } disabled:cursor-not-allowed`}
              >
                {i < stepIndex && !isRunning ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <step.icon className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">{step.label}</span>
              </button>

              {i < steps.length - 1 && (
                <div className={`flex-1 h-px mx-2 ${i < stepIndex ? 'bg-success/30' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel - Agent workspace */}
        <div className="flex-1 overflow-auto p-6">
          {activeStep === 'queries' && (
            <div className="max-w-2xl space-y-4">
              <h2 className="text-lg font-medium text-text-primary">Analysis Queries</h2>
              <p className="text-sm text-text-muted">Define the queries and metrics to analyze. The agent will run these against the experiment database.</p>
              
              <div className="space-y-3 mt-4">
                <textarea
                  placeholder={`-- Example queries\nSELECT COUNT(*) as total_samples FROM results;\nSELECT status, AVG(latency_ms) as avg_latency FROM results GROUP BY status;`}
                  className="w-full h-64 p-3 bg-bg-secondary border border-border rounded-md text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent resize-none"
                />

                <button className="px-4 py-2 rounded-md text-sm bg-bg-hover hover:bg-bg-tertiary text-text-primary transition-colors">
                  + Add Query
                </button>
              </div>
            </div>
          )}

          {activeStep === 'anecdotes' && (
            <div className="max-w-2xl space-y-4">
              <h2 className="text-lg font-medium text-text-primary">Anecdotal Evidence</h2>
              <p className="text-sm text-text-muted">Review individual samples that illustrate key patterns. Add notes and context.</p>

              <div className="mt-4 space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className="bg-bg-secondary border border-border rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-mono text-accent">Sample #{i}</span>
                      <button className="text-xs text-text-muted hover:text-text-primary transition-colors">Pin</button>
                    </div>
                    <p className="text-sm text-text-secondary line-clamp-2">
                      This sample demonstrates the pattern we observed in the quantitative analysis...
                    </p>
                    <textarea
                      placeholder="Add anecdotal note..."
                      className="w-full mt-2 p-2 bg-bg-primary border border-border rounded-md text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent resize-none"
                      rows={2}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeStep === 'summary' && (
            <div className="max-w-3xl space-y-4">
              <h2 className="text-lg font-medium text-text-primary">Summary</h2>
              <p className="text-sm text-text-muted">Write your analysis summary. The agent will incorporate findings from queries and anecdotes.</p>

              <textarea
                value={findings}
                onChange={(e) => setFindings(e.target.value)}
                placeholder="# Analysis Summary\n\n## Overview\n\n..."
                className="w-full h-[500px] p-4 bg-bg-secondary border border-border rounded-md text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent resize-none mt-4"
              />

              <div className="flex items-center gap-2">
                <button onClick={handleSave} className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-white text-sm transition-colors">
                  <Save className="w-3.5 h-3.5" />
                  Save Analysis
                </button>
              </div>
            </div>
          )}

          {activeStep === 'review' && (
            <div className="max-w-3xl space-y-4">
              <h2 className="text-lg font-medium text-text-primary">Review & Proofread</h2>
              <p className="text-sm text-text-muted">Review the agent's work before finalizing. Check for accuracy, completeness, and clarity.</p>

              <div className="mt-4 bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
                <div className="flex items-start gap-3 p-3 bg-success/5 border border-success/20 rounded-md">
                  <CheckCircle2 className="w-4 h-4 text-success mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-success">Analysis Complete</p>
                    <p className="text-xs text-text-muted mt-1">All queries executed successfully. 3 anecdotes collected.</p>
                  </div>
                </div>

                <details className="group">
                  <summary className="text-sm cursor-pointer text-accent hover:text-accent-hover transition-colors">View full analysis</summary>
                  <pre className="mt-2 p-3 bg-bg-primary rounded-md text-xs text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto">
{findings || '# Analysis Report\n\nNo findings yet. Run the agent to generate results.'}
                  </pre>
                </details>
              </div>

              <div className="flex items-center gap-2 mt-4">
                <button onClick={handleSave} className="px-4 py-2 rounded-md bg-accent hover:bg-accent-hover text-white text-sm transition-colors">
                  Finalize & Export
                </button>
                <button className="px-4 py-2 rounded-md bg-bg-hover hover:bg-bg-tertiary text-text-primary text-sm transition-colors">
                  Regenerate
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right panel - Results preview */}
        <div className="w-80 border-l border-border bg-bg-secondary overflow-auto">
          <div className="p-3 border-b border-border">
            <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider">Results</h3>
          </div>

          <div className="p-3 space-y-3">
            {/* Metrics */}
            <div className="bg-bg-primary rounded-md p-3 border border-border">
              <h4 className="text-xs font-medium text-text-muted mb-2">Metrics</h4>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-text-secondary">Queries run</span>
                  <span className="font-mono text-accent">3</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-text-secondary">Samples analyzed</span>
                  <span className="font-mono text-accent">1,247</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-text-secondary">Anecdotes collected</span>
                  <span className="font-mono text-accent">3</span>
                </div>
              </div>
            </div>

            {/* Export */}
            <button className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs bg-bg-hover hover:bg-bg-tertiary text-text-primary transition-colors">
              <Save className="w-3 h-3" />
              Export Findings
            </button>

            {/* Activity log */}
            <div className="bg-bg-primary rounded-md p-3 border border-border">
              <h4 className="text-xs font-medium text-text-muted mb-2">Activity</h4>
              <div className="space-y-1.5">
                {steps.map(step => (
                  <div key={step.id} className={`flex items-center gap-2 text-xs ${
                    step.id === activeStep ? 'text-accent' : steps.findIndex(s => s.id === activeStep) > steps.findIndex(s => s.id === step.id) ? 'text-success' : 'text-text-muted'
                  }`}>
                    <step.icon className="w-3 h-3" />
                    {step.label}
                    {steps.findIndex(s => s.id === activeStep) > steps.findIndex(s => s.id === step.id) && (
                      <CheckCircle2 className="w-3 h-3 ml-auto" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
