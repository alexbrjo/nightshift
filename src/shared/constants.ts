// Shared constants across the application

export const DEFAULT_PAGE_SIZE = 50
export const MAX_COLLECTION_ITEMS = 10000
export const HTTP_TIMEOUT_MS = 60_000
export const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

// File extensions and their language IDs for Monaco Editor
export const FILE_EXTENSIONS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonl: 'json',
  csv: 'csv',
  yaml: 'yaml',
  yml: 'yaml',
  jinja: 'html',
  jinja2: 'html',
  tmpl: 'html',
}

export const SUPPORTED_EXTENSIONS = Object.keys(FILE_EXTENSIONS)

// Default API settings
export const DEFAULT_API_ENDPOINT = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'gpt-4o'
export const DEFAULT_TEMPERATURE = 0.7
export const DEFAULT_MAX_TOKENS = 4096
