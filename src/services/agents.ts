import type { LLMProvider } from '../types'

export interface AnalysisTask {
  query: string
  context?: Record<string, unknown>
}

export interface AgentResult {
  success: boolean
  findings: string
  metrics?: Record<string, number>
}

class AnalysisAgent {
  private provider: LLMProvider
  private systemPrompt: string

  constructor(provider: LLMProvider) {
    this.provider = provider
    this.systemPrompt = `You are a research analysis agent. Your workflow:
1. Run analysis queries against the provided data
2. Supplement quantitative metrics with qualitative anecdotes  
3. Write a structured summary
4. Proofread and refine your work

Output results to analysis.md in proper markdown format.`
  }

  async runAnalysis(task: AnalysisTask): Promise<AgentResult> {
    try {
      const response = await fetch(`${this.provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.provider.apiKey}`
        },
        body: JSON.stringify({
          model: this.provider.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: task.query }
          ],
          temperature: 0.7
        })
      })

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`)
      }

      const data = await response.json()
      const findings = data.choices?.[0]?.message?.content || ''

      return {
        success: true,
        findings,
        metrics: {
          tokensUsed: data.usage?.total_tokens || 0
        }
      }
    } catch (error) {
      return {
        success: false,
        findings: '',
        metrics: {}
      }
    }
  }

  async runWorkflow(steps: AnalysisTask[]): Promise<AgentResult[]> {
    const results: AgentResult[] = []
    for (const step of steps) {
      const result = await this.runAnalysis(step)
      results.push(result)
    }
    return results
  }
}

export function createAnalysisAgent(provider: LLMProvider): AnalysisAgent {
  return new AnalysisAgent(provider)
}
