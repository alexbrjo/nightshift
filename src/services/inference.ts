import type { LLMProvider, CollectionItem } from '../types'

export interface InferenceConfig {
  template: string
  inputData?: Record<string, unknown>[]
  provider: LLMProvider
  samplingStrategy: 'single' | 'random' | 'exhaustive'
}

function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(variables[key] ?? ''))
}

export function generateVariations(
  inputData: Record<string, unknown>[],
  samplingStrategy: 'single' | 'random' | 'exhaustive'
): Record<string, unknown>[] {
  switch (samplingStrategy) {
    case 'single':
      return inputData.length > 0 ? [inputData[0]] : []
    case 'random':
      if (inputData.length === 0) return []
      const shuffled = [...inputData].sort(() => Math.random() - 0.5)
      return shuffled.slice(0, Math.min(10, shuffled.length))
    case 'exhaustive':
    default:
      return inputData
  }
}

export async function runInference(
  config: InferenceConfig,
  onProgress?: (item: CollectionItem) => void
): Promise<CollectionItem[]> {
  const { template, provider } = config
  const variations = generateVariations(config.inputData || [], config.samplingStrategy)
  const results: CollectionItem[] = []

  for (const vars of variations) {
    const renderedPrompt = renderTemplate(template, vars)
    const startTime = Date.now()
    
    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: 'user', content: renderedPrompt }],
          temperature: provider.temperature,
          max_tokens: provider.maxTokens
        })
      })

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      const latencyMs = Date.now() - startTime
      const message = data.choices?.[0]?.message?.content || ''
      
      let parsedContent = message
      try {
        parsedContent = JSON.parse(message)
      } catch {
        // Keep as raw string if not valid JSON
      }

      const item: CollectionItem = {
        id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        renderedPrompt,
        rawResponse: message,
        parsedContent,
        tokenUsage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0
        },
        latencyMs,
        status: 'completed'
      }

      results.push(item)
      onProgress?.(item)

    } catch (error) {
      const latencyMs = Date.now() - startTime
      const item: CollectionItem = {
        id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        renderedPrompt,
        rawResponse: '',
        parsedContent: null,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs,
        status: 'errored',
        error: error instanceof Error ? error.message : String(error)
      }
      
      results.push(item)
      onProgress?.(item)
    }
  }

  return results
}

export async function runBulkJS(
  code: string,
  inputData: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = []
  
  for (const item of inputData) {
    try {
      const fn = new Function('data', `
        'use strict';
        return (function(data) {
          ${code}
        })(data)
      `)
      const result = await fn(item)
      results.push({ success: true, data: result })
    } catch (error) {
      results.push({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        input: item
      })
    }
  }

  return results
}
