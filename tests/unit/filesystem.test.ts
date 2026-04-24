import { describe, it, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { readProjectFile, writeProjectFile, deleteProjectFile, listDirectory, getFileLanguage } from '../../electron/main/filesystem/fileService'

const TEST_DIR = join(__dirname, '..', '__fixtures__')

function setupTestDir(): void {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true })
  }
}

function cleanupTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
}

describe('Filesystem service', () => {
  beforeAll(() => setupTestDir())
  afterAll(() => cleanupTestDir())

  describe('writeProjectFile / readProjectFile', () => {
    it('should write and read a file', () => {
      const relativePath = 'test-file.txt'
      const content = 'Hello, Nightshift!'

      writeProjectFile(TEST_DIR, relativePath, content)
      const readContent = readProjectFile(TEST_DIR, relativePath)

      expect(readContent).toBe(content)
    })

    it('should create parent directories', () => {
      const relativePath = 'nested/deep/file.txt'
      const content = 'Deep file content'

      writeProjectFile(TEST_DIR, relativePath, content)
      const readContent = readProjectFile(TEST_DIR, relativePath)

      expect(readContent).toBe(content)
    })

    it('should overwrite existing files', () => {
      const relativePath = 'overwrite-test.txt'

      writeProjectFile(TEST_DIR, relativePath, 'first content')
      writeProjectFile(TEST_DIR, relativePath, 'second content')

      expect(readProjectFile(TEST_DIR, relativePath)).toBe('second content')
    })
  })

  describe('deleteProjectFile', () => {
    it('should delete a file', () => {
      const relativePath = 'to-delete.txt'
      writeProjectFile(TEST_DIR, relativePath, 'will be deleted')

      expect(existsSync(join(TEST_DIR, relativePath))).toBe(true)
      deleteProjectFile(TEST_DIR, relativePath)
      expect(existsSync(join(TEST_DIR, relativePath))).toBe(false)
    })

    it('should throw for non-existent file', () => {
      expect(() => deleteProjectFile(TEST_DIR, 'nonexistent-file.txt')).toThrow('File not found')
    })
  })

  describe('listDirectory', () => {
    it('should list directory contents', () => {
      // Create some test files first
      writeProjectFile(TEST_DIR, 'list-test-1.txt', 'a')
      writeProjectFile(TEST_DIR, 'list-test-2.json', '{"key": "val"}')

      const entries = listDirectory(TEST_DIR)
      const names = entries.map(e => e.name)

      expect(names).toContain('list-test-1.txt')
      expect(names).toContain('list-test-2.json')
    })

    it('should identify directories correctly', () => {
      mkdirSync(join(TEST_DIR, 'test-subdir'), { recursive: true })
      const entries = listDirectory(TEST_DIR)
      const dirEntry = entries.find(e => e.name === 'test-subdir')

      expect(dirEntry?.isDirectory).toBe(true)
    })
  })

  describe('getFileLanguage', () => {
    it('should return correct language for supported extensions', () => {
      expect(getFileLanguage('.js')).toBe('javascript')
      expect(getFileLanguage('.ts')).toBe('typescript')
      expect(getFileLanguage('.json')).toBe('json')
      expect(getFileLanguage('.csv')).toBe('csv')
      expect(getFileLanguage('.yaml')).toBe('yaml')
      expect(getFileLanguage('.jinja2')).toBe('html')
    })

    it('should return null for unsupported extensions', () => {
      expect(getFileLanguage('.png')).toBeNull()
      expect(getFileLanguage('.pdf')).toBeNull()
      expect(getFileLanguage('.exe')).toBeNull()
    })

    it('should handle case-insensitive extensions', () => {
      expect(getFileLanguage('.JS')).toBe('javascript')
      expect(getFileLanguage('.JSON')).toBe('json')
    })
  })
})
