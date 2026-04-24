import { describe, it, expect } from 'vitest'
import { generateId, exportToYaml, importFromYaml, paginate, sanitizeForJsonParsing, debounce, validateCollectionSize } from '../../src/shared/utils'
import { DEFAULT_PAGE_SIZE, MAX_COLLECTION_ITEMS } from '../../src/shared/constants'

describe('generateId', () => {
  it('should generate a valid UUID v4', () => {
    const id = generateId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('should generate unique IDs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateId())
    }
    expect(ids.size).toBe(100)
  })
})

describe('exportToYaml', () => {
  it('should serialize an object to YAML string', () => {
    const data = { name: 'test', value: 42, nested: { key: 'val' } }
    const yaml = exportToYaml(data)
    expect(yaml).toContain('name: test')
    expect(yaml).toContain('value: 42')
  })

  it('should handle empty object', () => {
    const yaml = exportToYaml({})
    expect(yaml).toBe('{}\n')
  })
})

describe('importFromYaml', () => {
  it('should parse YAML string to object', () => {
    const yaml = 'name: test\nvalue: 42'
    const data = importFromYaml(yaml)
    expect(data).toEqual({ name: 'test', value: 42 })
  })

  it('should handle nested YAML', () => {
    const yaml = 'outer:\n  inner: value\nlist:\n  - a\n  - b'
    const data = importFromYaml(yaml)
    expect(data).toEqual({ outer: { inner: 'value' }, list: ['a', 'b'] })
  })
})

describe('paginate', () => {
  it('should return correct page of items', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    const result = paginate(items, 2, 50)
    expect(result.items).toHaveLength(50)
    expect(result.items[0].id).toBe(50)
    expect(result.total).toBe(100)
    expect(result.page).toBe(2)
  })

  it('should handle last partial page', () => {
    const items = Array.from({ length: 75 }, (_, i) => ({ id: i }))
    const result = paginate(items, 2, 50)
    expect(result.items).toHaveLength(25)
    expect(result.total).toBe(75)
  })

  it('should use default page size', () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ id: i }))
    const result = paginate(items, 1)
    expect(result.items).toHaveLength(DEFAULT_PAGE_SIZE)
  })
})

describe('sanitizeForJsonParsing', () => {
  it('should parse valid JSON strings', () => {
    expect(sanitizeForJsonParsing('{"key": "value"}')).toEqual({ key: 'value' })
    expect(sanitizeForJsonParsing('[1, 2, 3]')).toEqual([1, 2, 3])
    expect(sanitizeForJsonParsing('"hello"')).toBe('hello')
  })

  it('should return null for invalid JSON', () => {
    expect(sanitizeForJsonParsing('{invalid}')).toBeNull()
    expect(sanitizeForJsonParsing('not json at all')).toBeNull()
    expect(sanitizeForJsonParsing('')).toBeNull()
  })
})

describe('debounce', () => {
  it('should delay function execution', async () => {
    let callCount = 0
    const fn = debounce(() => { callCount++ }, 100)

    fn()
    fn()
    fn()

    expect(callCount).toBe(0)

    await new Promise(resolve => setTimeout(resolve, 150))
    expect(callCount).toBe(1)
  })
})

describe('validateCollectionSize', () => {
  it('should not throw for valid sizes', () => {
    expect(() => validateCollectionSize(0)).not.toThrow()
    expect(() => validateCollectionSize(MAX_COLLECTION_ITEMS - 1)).not.toThrow()
  })

  it('should throw when at or over limit', () => {
    expect(() => validateCollectionSize(MAX_COLLECTION_ITEMS)).toThrow('Collection limit reached')
    expect(() => validateCollectionSize(MAX_COLLECTION_ITEMS + 100)).toThrow('Collection limit reached')
  })
})
