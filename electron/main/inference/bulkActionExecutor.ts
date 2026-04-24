import { VM, VMScript } from 'vm2'
import type { DbConnection } from '../db/database'
import { getCollectionItems, insertCollectionItems } from '../db/database'
import { readProjectFile } from '../filesystem/fileService'
import { validateCollectionSize } from '@shared/utils'

// ─── Sandboxed context configuration ───────────────────────────────────

const SANDBOX_CONFIG = {
  timeout: 30_000, // 30 second timeout per item
  maxBuffer: 5 * 1024 * 1024, // 5MB output buffer
  sandbox: {
    // Provide safe utilities in the sandbox
    console: {
      log: (...args: unknown[]) => {}, // No-op console in sandbox
      warn: (...args: unknown[]) => {},
      error: (...args: unknown[]) => {},
    },
  },
}

// ─── Bulk action executor ──────────────────────────────────────────────

export interface ActionResult {
  success: boolean
  results?: Record<string, unknown>[]
  error?: string
  processedCount: number
  successCount: number
  errorCount: number
}

export class BulkActionExecutor {
  private db: DbConnection['db']

  constructor(db: DbConnection['db']) {
    this.db = db
  }

  async execute(
    actionId: string,
    projectPath: string,
    sourceCollection: string,
    targetCollection: string,
    scriptFile: string,
    batchSize: number = 100
  ): Promise<ActionResult> {
    let totalProcessed = 0
    let totalSuccess = 0
    let totalError = 0
    const allResults: Record<string, unknown>[] = []

    // Load the script from file
    const relativeScriptPath = scriptFile.replace(projectPath + '/', '')
    const scriptContent = readProjectFile(projectPath, relativeScriptPath)

    // Wrap user script in a function that receives each item
    const wrappedScript = `
      (function(item, index, collectionSize) {
        ${scriptContent}
        return result;
      })
    `

    let page = 1
    while (true) {
      const { items, total } = getCollectionItems(this.db, sourceCollection, page, batchSize)

      if (items.length === 0) break

      for (const item of items) {
        totalProcessed++

        try {
          // Validate collection size before inserting results
          const targetCount = this.getTargetItemCount(targetCollection)
          validateCollectionSize(totalSuccess + targetCount)

          // Create sandboxed VM instance per execution for isolation
          const vm = new VM({
            ...SANDBOX_CONFIG,
            sandbox: {
              ...SANDBOX_CONFIG.sandbox,
              item: structuredClone(item),
              index: page * batchSize - batchSize + items.indexOf(item),
              collectionSize: total,
              result: null,
            },
          })

          const script = new VMScript(wrappedScript, `action_${actionId}_${totalProcessed}`)
          const fn = vm.run(script)

          // Execute the user's function
          const output = fn(item, page * batchSize - batchSize + items.indexOf(item), total)

          if (output && typeof output === 'object') {
            allResults.push(output as Record<string, unknown>)
            totalSuccess++
          } else {
            totalError++
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          console.error(`[BulkAction] Error processing item ${totalProcessed}:`, errorMessage)
          totalError++
        }
      }

      // Batch insert results to improve performance
      if (allResults.length >= 50) {
        this.insertBatch(targetCollection, allResults.splice(0, 50))
      }

      // If we got fewer items than batch size, we've reached the end
      if (items.length < batchSize) break
      page++
    }

    // Insert remaining results
    if (allResults.length > 0) {
      this.insertBatch(targetCollection, allResults)
    }

    return {
      success: totalError === 0 || totalSuccess > 0,
      error: totalError > 0 ? `${totalError} items failed processing` : undefined,
      processedCount: totalProcessed,
      successCount: totalSuccess,
      errorCount: totalError,
    }
  }

  private getTargetItemCount(collectionName: string): number {
    try {
      const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
      const result = this.db.prepare(`SELECT COUNT(*) as count FROM items_${safeName}`).get() as { count: number } | undefined
      return result?.count ?? 0
    } catch {
      return 0
    }
  }

  private insertBatch(collectionName: string, items: Record<string, unknown>[]): void {
    const safeName = collectionName.replace(/[^a-zA-Z0-9_]/g, '_')
    try {
      this.db.prepare(
        `INSERT INTO items_${safeName} (id, data, created_at) VALUES (?, ?, ?)`
      ).raw(true).run(
        ...items.flatMap(item => [
          require('uuid').v4(),
          JSON.stringify(item),
          Date.now(),
        ])
      )
    } catch {
      // Table might not exist yet - create it
      this.db.exec(`CREATE TABLE IF NOT EXISTS items_${safeName} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`)

      for (const item of items) {
        this.db.prepare(
          `INSERT INTO items_${safeName} (id, data, created_at) VALUES (?, ?, ?)`
        ).run(require('uuid').v4(), JSON.stringify(item), Date.now())
      }
    }
  }
}
