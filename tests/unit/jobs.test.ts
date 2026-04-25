import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jobConfigSchema, parseData, callLLM } from '../../src/server/jobs';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('jobs', () => {
  describe('validation', () => {
    it('accepts valid config', () => {
      const config = {
        name: 'Test Job',
        samples: 10,
        strategy: 'single' as const,
        templatePath: 'template.jinja',
        dataPath: 'data.jsonl',
        host: 'http://localhost:3000',
        model: 'gpt-4',
        outputMode: 'json' as const,
        temperature: 0.7,
        maxTokens: 1024,
      };
      expect(() => jobConfigSchema.parse(config)).not.toThrow();
    });

    it('rejects invalid config', () => {
      const config = {
        name: '',
        samples: -1,
        strategy: 'bad',
        templatePath: '',
        host: '',
        model: '',
        outputMode: 'bad',
        temperature: 'hot',
        maxTokens: 0,
      };
      expect(() => jobConfigSchema.parse(config)).toThrow();
    });
  });

  describe('parseData', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('parses JSON data', () => {
      const file = path.join(tmpDir, 'data.json');
      fs.writeFileSync(file, JSON.stringify([{ name: 'Alice' }, { name: 'Bob' }]));
      const result = parseData(file);
      expect(result).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    });

    it('parses JSONL data', () => {
      const file = path.join(tmpDir, 'data.jsonl');
      fs.writeFileSync(file, '{"name":"Alice"}\n{"name":"Bob"}\n');
      const result = parseData(file);
      expect(result).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    });

    it('parses CSV data', () => {
      const file = path.join(tmpDir, 'data.csv');
      fs.writeFileSync(file, 'name,age\nAlice,30\nBob,25\n');
      const result = parseData(file);
      expect(result).toEqual([
        { name: 'Alice', age: '30' },
        { name: 'Bob', age: '25' },
      ]);
    });
  });

  describe('callLLM', () => {
    it('calls the API via axios', async () => {
      const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
        data: { choices: [{ message: { content: 'Hello' } }] },
      } as any);

      const result = await callLLM('http://localhost:3000', 'gpt-4', 'Say hello', 0.5, 100);
      expect(postSpy).toHaveBeenCalled();
      expect(result).toBe('Hello');
      postSpy.mockRestore();
    });
  });
});
