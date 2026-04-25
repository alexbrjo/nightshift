import { describe, it, expect, vi } from 'vitest';
import { actionConfigSchema, executeActionScript } from '../../src/server/actions';
import * as sandbox from '../../src/server/sandbox';

describe('actions', () => {
  describe('validation', () => {
    it('accepts valid action config', () => {
      const config = {
        sourceCollection: 'src',
        scriptPath: 'script.js',
        targetCollection: 'tgt',
      };
      expect(() => actionConfigSchema.parse(config)).not.toThrow();
    });

    it('rejects invalid action config', () => {
      const config = {
        sourceCollection: '',
        scriptPath: '',
        targetCollection: '',
      };
      expect(() => actionConfigSchema.parse(config)).toThrow();
    });
  });

  describe('executeActionScript', () => {
    it('invokes sandbox with correct context', async () => {
      const runSpy = vi.spyOn(sandbox, 'runSandboxedJS').mockResolvedValue({ result: 42 });
      const result = await executeActionScript('return data.value * 2', { value: 21 });
      expect(runSpy).toHaveBeenCalledWith('return data.value * 2', { data: { value: 21 } });
      expect(result).toEqual({ result: 42 });
      runSpy.mockRestore();
    });
  });
});
