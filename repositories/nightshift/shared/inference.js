const { OpenAI } = require('openai');
const jinja2 = require('jinja2'); // Note: js-jinja2 or similar

class InferenceEngine {
  constructor(apiKey, baseUrl = 'https://api.openai.com/v1') {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async renderTemplate(templateStr, data) {
    // Simplistic Jinja-like rendering for the prototype
    let rendered = templateStr;
    for (const [key, value] of Object.entries(data)) {
      rendered = rendered.replace(new RegExp(`{{ ${key} }}`, 'g'), value);
    }
    return rendered;
  }

  async runInference(prompt, options) {
    const start = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: options.model || 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
        // Thinking budget would be model specific (e.g. o1), omitting for general compat
      });

      const duration = Date.now() - start;
      return {
        raw: response.choices[0].message.content,
        metrics: {
          latency: duration,
          tokens: response.usage,
        },
        error: null
      };
    } catch (err) {
      return { raw: null, metrics: null, error: err.message };
    }
  }

  async runJob(jobConfig, inputData, onProgress) {
    const results = [];
    const { template, model, temperature, maxTokens } = jobConfig;
    
    for (let i = 0; i < inputData.length; i++) {
      const data = inputData[i];
      const prompt = await this.renderTemplate(template, data);
      const res = await this.runInference(prompt, { model, temperature, maxTokens });
      
      results.push({
        input: data,
        prompt,
        ...res
      });
      if (onProgress) onProgress((i + 1) / inputData.length);
    }
    return results;
  }
}

module.exports = InferenceEngine;
