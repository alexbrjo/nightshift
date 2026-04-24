import { v4 as uuidv4 } from 'uuid'
import yaml from 'js-yaml'
import { MAX_COLLECTION_ITEMS, DEFAULT_PAGE_SIZE } from './constants'

export function generateId(): string {
  return uuidv4()
}

export function exportToYaml(data: unknown): string {
  return yaml.dump(data, { lineWidth: -1, noRefs: true }) as string
}

export function importFromYaml<T = Record<string, unknown>>(yamlStr: string): T {
  return yaml.load(yamlStr) as T
}

export function paginate<T>(items: T[], page: number, pageSize = DEFAULT_PAGE_SIZE): { items: T[]; total: number; page: number } {
  const start = (page - 1) * pageSize
  const end = start + pageSize
  return {
    items: items.slice(start, end),
    total: items.length,
    page,
  }
}

export function validateCollectionSize(currentSize: number): void {
  if (currentSize >= MAX_COLLECTION_ITEMS) {
    throw new Error(`Collection limit reached: ${MAX_COLLECTION_ITEMS} items maximum`)
  }
}

export function sanitizeForJsonParsing(str: string): unknown | null {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>
  return function (this: unknown, ...args: Parameters<T>) {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn.apply(this, args), ms)
  }
}

export function escapeHtml(str: string): string {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}
