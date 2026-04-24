import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { DbConnection } from '../db/database'
import { getCollectionItems, createAgentRun, updateAgentRunSummary } from '../db/database'

// ─── Agent workflow steps ──────────────────────────────────────

interface AnalysisResult {
  queries: Record<string, unknown>[]
  anecdotes: string[]
  summary: string
  proofreadNotes: string[]
}

export class AnalysisAgent {
  private db: DbConnection['db']

  constructor(db: DbConnection['db']) {
    this.db = db
  }

  async run(
    agentConfigId: string,
    projectId: string,
    projectPath: string,
    outputCollection?: string
  ): Promise<string> {
    // Create per-run isolated database (copy-on-create model)
    const runDbDir = join(projectPath, '.nightshift')
    if (!existsSync(runDbDir)) {
      mkdirSync(runDbDir, { recursive: true })
    }

    const runDbPath = join(runDbDir, `agent_run_${agentConfigId}_${Date.now()}.db`)
    this.createIsolatedRunDb(runDbPath)

    // Clone relevant tables into the per-run database
    this.cloneTablesForAgentRun(runDbPath, projectPath)

    // Create agent run record
    const runId = createAgentRun(this.db, agentConfigId, runDbPath)

    try {
      // Open isolated DB for agent operations
      const runDb = new Database(runDbPath)
      runDb.pragma('journal_mode = WAL')
      runDb.pragma('foreign_keys = ON')

      // Execute the structured workflow:
      // 1. Run analysis queries
      // 2. Supplement with anecdotes
      // 3. Write summary
      // 4. Proof-read work

      const result = await this.executeWorkflow(runDb, agentConfigId)

      // Write results to isolated DB and update main DB
      runDb.prepare('INSERT INTO agent_results (run_id, analysis_queries, anecdotes, summary, proofread_notes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        runId,
        JSON.stringify(result.queries),
        JSON.stringify(result.anecdotes),
        result.summary,
        JSON.stringify(result.proofreadNotes),
        Date.now()
      )

      // Write analysis.md to project directory
      const analysisMdPath = join(projectPath, '.nightshift', `analysis_${runId}.md`)
      writeFileSync(analysisMdPath, this.formatAnalysisMarkdown(result))

      updateAgentRunSummary(this.db, runId, result.summary)

      runDb.close()

      return runId
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error(`[AnalysisAgent] Run failed:`, errorMessage)
      throw err
    }
  }

  private createIsolatedRunDb(runDbPath: string): void {
    const db = new Database(runDbPath)
    db.pragma('journal_mode = WAL')

    // Create minimal schema for the isolated run DB
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_input_data (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        analysis_queries TEXT,
        anecdotes TEXT,
        summary TEXT,
        proofread_notes TEXT,
        created_at INTEGER NOT NULL
      );
    `)

    db.close()
  }

  private cloneTablesForAgentRun(runDbPath: string, projectPath: string): void {
    // In production, this would clone schemas, input data, and intermediate results
    // from the main project database into the per-run isolated database.
    // For now, we create the table structure - actual cloning happens when data is available.
    const db = new Database(runDbPath)

    // Create a placeholder for cloned data
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloned_schemas (
        name TEXT PRIMARY KEY,
        schema_def TEXT NOT NULL,
        cloned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloned_input_data (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        source_collection TEXT,
        cloned_at INTEGER NOT NULL
      );
    `)

    db.close()
  }

  private async executeWorkflow(runDb: Database.Database, agentConfigId: string): Promise<AnalysisResult> {
    // Step 1: Run analysis queries on the isolated data
    const queries = await this.runAnalysisQueries(runDb)

    // Step 2: Supplement quantitative metrics with anecdotes
    const anecdotes = this.generateAnecdotes(queries)

    // Step 3: Write summary
    const summary = this.writeSummary(queries, anecdotes)

    // Step 4: Proof-read work
    const proofreadNotes = this.proofRead(summary, queries)

    return {
      queries,
      anecdotes,
      summary,
      proofreadNotes,
    }
  }

  private async runAnalysisQueries(runDb: Database.Database): Promise<Record<string, unknown>[]> {
    // Run predefined analysis queries against the isolated data
    const results: Record<string, unknown>[] = []

    // Count total items
    const countResult = runDb.prepare('SELECT COUNT(*) as total FROM agent_input_data').get() as { total: number } | undefined
    results.push({ query: 'total_items', result: { total: countResult?.total ?? 0 } })

    // Sample data distribution (if input data exists)
    const sample = runDb.prepare('SELECT data FROM agent_input_data LIMIT 10').all() as { data: string }[]
    results.push({ query: 'sample_data', result: sample.map(s => JSON.parse(s.data)) })

    return results
  }

  private generateAnecdotes(queries: Record<string, unknown>[]): string[] {
    const anecdotes: string[] = []

    for (const q of queries) {
      if (q.query === 'sample_data' && Array.isArray(q.result)) {
        for (const item of q.result.slice(0, 3)) {
          const name = (item as Record<string, unknown>).name ?? '(unnamed)'
          anecdotes.push(`Sample "${String(name)}" shows interesting patterns in the output.`)
        }
      }
    }

    return anecdotes
  }

  private writeSummary(queries: Record<string, unknown>[], anecdotes: string[]): string {
    const totalItems = queries.find(q => q.query === 'total_items')?.result as { total: number } | undefined
    const total = totalItems?.total ?? 0

    let summary = `# Analysis Summary\n\n`
    summary += `## Overview\n\n`
    summary += `Analyzed ${total} items from the experiment.\n\n`

    if (anecdotes.length > 0) {
      summary += `## Key Observations\n\n`
      for (const anecdote of anecdotes) {
        summary += `- ${anecdote}\n`
      }
      summary += `\n`
    }

    summary += `## Conclusion\n\n`
    summary += `The experiment produced ${total} results. Further analysis recommended.\n`

    return summary
  }

  private proofRead(summary: string, queries: Record<string, unknown>[]): string[] {
    const notes: string[] = []

    // Check for completeness
    if (summary.length < 50) {
      notes.push('Summary is very brief. Consider adding more detail.')
    }

    // Verify data references match query results
    const totalItems = queries.find(q => q.query === 'total_items')?.result as { total: number } | undefined
    if (totalItems && totalItems.total === 0) {
      notes.push('No input data was found. Analysis may be incomplete.')
    }

    return notes
  }

  private formatAnalysisMarkdown(result: AnalysisResult): string {
    let md = '# Analysis Report\n\n'

    // Queries section
    md += '## Analysis Queries\n\n'
    for (const query of result.queries) {
      md += `### ${query.query}\n\n`
      md += `\`\`\`\n${JSON.stringify(query.result, null, 2)}\n\`\`\`\n\n`
    }

    // Anecdotes section
    if (result.anecdotes.length > 0) {
      md += '## Anecdotal Evidence\n\n'
      for (const anecdote of result.anecdotes) {
        md += `- ${anecdote}\n`
      }
      md += '\n'
    }

    // Summary section
    md += '## Summary\n\n'
    md += result.summary + '\n'

    // Proof-read notes
    if (result.proofreadNotes.length > 0) {
      md += '## Proof-Read Notes\n\n'
      for (const note of result.proofreadNotes) {
        md += `- [ ] ${note}\n`
      }
    }

    return md
  }

  exportFindings(runDbPath: string): string {
    const db = new Database(runDbPath)

    const results = db.prepare('SELECT * FROM agent_results ORDER BY created_at DESC').all() as Record<string, unknown>[]
    db.close()

    return JSON.stringify(results, null, 2)
  }
}
