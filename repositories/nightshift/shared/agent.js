const { OpenAI } = require('openai');

class AnalysisAgent {
  constructor(apiKey, db) {
    this.client = new OpenAI({ apiKey });
    this.db = db;
  }

  async runAnalysis() {
    // 1. Gather metrics from DB
    const samples = this.db.query('SELECT * FROM samples');
    const dataContext = JSON.stringify(samples);

    // 2. Structured workflow
    const steps = [
      'Perform quantitative analysis of the results',
      'Identify key anomalies or success patterns (anecdotes)',
      'Write a final summary report',
      'Proof-read and refine the output'
    ];

    let currentContext = `Dataset: ${dataContext}`;
    let finalReport = '';

    for (const step of steps) {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are an expert LLM evaluation agent.' },
          { role: 'user', content: `${step}\n\nContext:\n${currentContext}` }
        ]
      });
      const output = response.choices[0].message.content;
      finalReport += `## ${step}\n\n${output}\n\n`;
      currentContext += `\n\nPrevious step result: ${output}`;
    }

    return finalReport;
  }
}

module.exports = AnalysisAgent;
