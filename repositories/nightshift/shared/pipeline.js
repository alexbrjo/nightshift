const { OpenAI } = require('openai');

class PipelineEngine {
  constructor(apiKey, projectDb) {
    this.apiKey = apiKey;
    this.db = projectDb;
  }

  async executePipeline(pipelineDef, inputData) {
    let currentData = inputData;
    const stages = JSON.parse(pipelineDef).stages;

    for (const stage of stages) {
      if (stage.type === 'inference') {
        const engine = new InferenceEngine(this.apiKey);
        const results = await engine.runJob(stage.config, currentData);
        currentData = results.map(r => r.raw || r.error); 
        // Simplification: pass raw output to next stage as array of strings/objects
      } else if (stage.type === 'javascript') {
        const results = currentData.map(data => Sandbox.execute(stage.config.code, data));
        currentData = results.map(r => r.result);
      }
    }
    return currentData;
  }
}

module.exports = PipelineEngine;
