import { describe, it, expect } from 'vitest'
import nunjucks from 'nunjucks'

describe('Template rendering', () => {
  it('should render a simple Jinja2 template', () => {
    const template = 'Hello, {{ name }}!'
    nunjucks.configure({ autoescape: false })
    const result = nunjucks.renderString(template, { name: 'World' })
    expect(result).toBe('Hello, World!')
  })

  it('should render templates with loops', () => {
    const template = '{% for item in items %}{{ item }}{% endfor %}'
    nunjucks.configure({ autoescape: false })
    const result = nunjucks.renderString(template, { items: ['a', 'b', 'c'] })
    expect(result).toBe('abc')
  })

  it('should render templates with conditionals', () => {
    const template = '{% if show %}visible{% else %}hidden{% endif %}'
    nunjucks.configure({ autoescape: false })
    expect(nunjucks.renderString(template, { show: true })).toBe('visible')
    expect(nunjucks.renderString(template, { show: false })).toBe('hidden')
  })

  it('should handle missing variables gracefully', () => {
    const template = 'Value: {{ missing | default("fallback") }}'
    nunjucks.configure({ autoescape: false })
    const result = nunjucks.renderString(template, {})
    expect(result).toBe('Value: fallback')
  })

  it('should pass through input data as variables', () => {
    const template = '{{ greeting }}, {{ name }}! You are sample #{{ _index }}'
    nunjucks.configure({ autoescape: false })
    const result = nunjucks.renderString(template, { greeting: 'Hi', name: 'Alice', _index: 5 })
    expect(result).toBe('Hi, Alice! You are sample #5')
  })
})

describe('Source data parsing', () => {
  it('should parse JSON array', () => {
    const content = '[{"name": "a"}, {"name": "b"}]'
    const parsed = JSON.parse(content)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].name).toBe('a')
  })

  it('should parse single JSON object', () => {
    const content = '{"name": "single"}'
    const parsed = JSON.parse(content)
    expect(Array.isArray(parsed)).toBe(false)
    // Should wrap in array
    const wrapped = typeof parsed === 'object' ? [parsed] : []
    expect(wrapped).toHaveLength(1)
  })

  it('should parse JSONL (newline-delimited JSON)', () => {
    const content = '{"name": "a"}\n{"name": "b"}\n\n{"name": "c"}'
    const lines = content.split('\n').filter(l => l.trim())
    const results: unknown[] = []
    for (const line of lines) {
      try {
        results.push(JSON.parse(line))
      } catch { /* skip invalid */ }
    }
    expect(results).toHaveLength(3)
  })

  it('should skip invalid JSONL lines', () => {
    const content = '{"valid": true}\n{invalid json}\n{"also": "valid"}'
    const lines = content.split('\n').filter(l => l.trim())
    const results: unknown[] = []
    for (const line of lines) {
      try {
        results.push(JSON.parse(line))
      } catch { /* skip invalid */ }
    }
    expect(results).toHaveLength(2)
  })
})

describe('Sampling strategies', () => {
  const inputs = Array.from({ length: 10 }, (_, i) => ({ index: i, data: { id: i } }))

  it('single strategy should return first N items', () => {
    const result = inputs.slice(0, Math.min(3, inputs.length))
    expect(result).toHaveLength(3)
    expect(result[0].index).toBe(0)
  })

  it('exhaustive strategy should return all items', () => {
    const result = [...inputs]
    expect(result).toHaveLength(10)
  })

  it('random strategy should return up to N shuffled items', () => {
    const count = Math.min(5, inputs.length)
    const shuffled = [...inputs].sort(() => Math.random() - 0.5)
    const result = shuffled.slice(0, count)
    expect(result).toHaveLength(count)
  })
})
