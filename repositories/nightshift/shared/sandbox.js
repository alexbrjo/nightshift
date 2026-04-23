const vm = require('vm');

class Sandbox {
  static execute(code, data) {
    try {
      const script = new vm.Script(code);
      const context = vm.createContext({ 
        data, 
        console: { log: (...args) => console.log('[Sandbox]', ...args) } 
      });
      const result = script.runInContext(context, { timeout: 5000 });
      return { result, error: null };
    } catch (err) {
      return { result: null, error: err.message };
    }
  }
}

module.exports = Sandbox;
