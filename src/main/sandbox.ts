import { VM } from 'vm2';

export async function runSandboxedScript(script: string, data: any): Promise<any> {
  const vm = new VM({
    timeout: 5000,
    sandbox: {
      data,
    },
  });

  try {
    // The script is expected to be a function that takes 'data' and returns the result.
    // For example: (data) => { return { ...data, newField: 'value' }; }
    // We wrap it in an async IIFE to allow for async/await if needed.
    const wrappedScript = `(async () => { ${script} })()`;
    return await vm.run(wrappedScript);
  } catch (err) {
    throw new Error(`Sandbox execution failed: ${err.message}`);
  }
}
