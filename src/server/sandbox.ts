import { getQuickJS } from 'quickjs-emscripten';

export async function runSandboxedJS(
  code: string,
  context: Record<string, unknown>,
  options?: { timeoutMs?: number }
): Promise<unknown> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime({ memoryLimitBytes: 64 * 1024 * 1024 });

  let callCount = 0;
  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? 5000;
  runtime.setInterruptHandler(() => {
    callCount++;
    if (callCount % 1000 === 0) {
      return Date.now() - startTime > timeoutMs;
    }
    return false;
  });

  const vm = runtime.newContext();

  try {
    for (const [key, value] of Object.entries(context)) {
      const json = JSON.stringify(value);
      const initResult = vm.evalCode(`var ${key} = JSON.parse(${JSON.stringify(json)});`, 'init.js');
      if (initResult.error) {
        const err = vm.dump(initResult.error);
        initResult.error.dispose();
        throw new Error(typeof err === 'string' ? err : err?.message || JSON.stringify(err));
      }
      initResult.value?.dispose();
    }

    const result = vm.evalCode(`(function(){ ${code} })()`, 'sandbox.js');
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      throw new Error(typeof err === 'string' ? err : err?.message || JSON.stringify(err));
    }
    const val = vm.dump(result.value);
    result.value.dispose();
    return val;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
