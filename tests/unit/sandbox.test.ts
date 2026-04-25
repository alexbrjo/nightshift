import { describe, it, expect } from 'vitest';
import { runSandboxedJS } from '../../src/server/sandbox';

describe('sandbox', () => {
  it('computes a simple math result', async () => {
    const result = await runSandboxedJS('return 2 + 2', {});
    expect(result).toBe(4);
  });

  it('catches thrown errors', async () => {
    await expect(runSandboxedJS('throw new Error("oops")', {})).rejects.toThrow('oops');
  });

  it('interrupts infinite loops', async () => {
    await expect(
      runSandboxedJS('while(true){ let x = 1; }', {}, { timeoutMs: 500 })
    ).rejects.toThrow();
  });
});
