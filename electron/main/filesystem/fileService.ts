import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, basename, extname, resolve } from 'path'

export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  modifiedAt?: number
}

export function readProjectFile(projectPath: string, relativePath: string): string {
  const fullPath = join(projectPath, relativePath)
  validateFilePath(fullPath, projectPath)
  return readFileSync(fullPath, 'utf-8')
}

export function writeProjectFile(projectPath: string, relativePath: string, content: string): void {
  const fullPath = join(projectPath, relativePath)
  validateFilePath(fullPath, projectPath)

  // Ensure parent directory exists
  const dir = join(fullPath, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(fullPath, content, 'utf-8')
}

export function deleteProjectFile(projectPath: string, relativePath: string): void {
  const fullPath = join(projectPath, relativePath)
  validateFilePath(fullPath, projectPath)

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`)
  }

  unlinkSync(fullPath)
}

export function listDirectory(projectPath: string, relativePath = ''): FileInfo[] {
  const fullPath = join(projectPath, relativePath)
  validateFilePath(fullPath, projectPath)

  if (!existsSync(fullPath)) {
    throw new Error(`Directory not found: ${relativePath}`)
  }

  const entries = readdirSync(fullPath, { withFileTypes: true })

  return entries.map(entry => {
    const entryPath = join(relativePath, entry.name)
    const fullEntryPath = join(projectPath, entryPath)

    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: true,
      }
    }

    try {
      const stats = statSync(fullEntryPath)
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: false,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
      }
    } catch {
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: false,
      }
    }
  })
}

export function getProjectName(projectPath: string): string {
  return basename(projectPath)
}

function validateFilePath(fullPath: string, projectPath: string): void {
  const resolvedFull = resolve(join(projectPath, fullPath))
  const resolvedProject = resolveProjectRoot(projectPath)

  if (!resolvedFull.startsWith(resolvedProject)) {
    throw new Error(`Access denied: path escapes project directory`)
  }
}

function resolveProjectRoot(projectPath: string): string {
  return resolve(projectPath).replace(/[\/\\]+$/, '') + '/'
}

export function getFileLanguage(ext: string): string | null {
  const extLower = ext.toLowerCase().replace('.', '')
  const langMap: Record<string, string> = {
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
  return langMap[extLower] || null
}

export function findFilesByExtension(projectPath: string, extensions: string[], relativePath = ''): FileInfo[] {
  const results: FileInfo[] = []
  const fullPath = join(projectPath, relativePath)

  if (!existsSync(fullPath)) return results

  const entries = readdirSync(fullPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(relativePath, entry.name)
    const fullEntryPath = join(projectPath, entryPath)

    if (entry.isDirectory()) {
      results.push(...findFilesByExtension(projectPath, extensions, entryPath))
    } else {
      const ext = extname(entry.name).toLowerCase()
      if (extensions.includes(ext)) {
        results.push({
          name: entry.name,
          path: entryPath,
          isDirectory: false,
        })
      }
    }
  }

  return results
}
