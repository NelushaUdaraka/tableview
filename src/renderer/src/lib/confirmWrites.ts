/**
 * What a confirm-writes connection shows before it writes: one line for each
 * statement that would change something, with where it changes it.
 *
 * Pure, so it can be tested without a window. The question itself is asked by
 * `stores/confirmWrites.ts`.
 */
import { findWritesInScript } from '@shared/sql/readOnly'

export interface WriteItem {
  /** 1-based line in the script, when it came from one. */
  line?: number
  /** What it does, starting with the keyword: `DELETE changes data`. */
  description: string
  /** The database it changes. */
  database: string
  /** Set on what cannot be taken back: the name to type, and why. */
  danger?: { name: string; reason: string }
}

/**
 * The writes in a script that starts in `database`. Empty when it only
 * reads, which is when it runs without asking.
 */
export function scriptWrites(sql: string, database: string): WriteItem[] {
  return findWritesInScript(sql).map((write) => ({
    line: write.line,
    description: write.description,
    database: write.database ?? database,
    danger: write.danger
  }))
}

/** Truncate from the tree: it cannot be taken back, so the table's name is typed. */
export function truncateWrite(schema: string, table: string, database: string): WriteItem {
  return {
    description: `TRUNCATE empties ${schema}.${table}`,
    database,
    danger: { name: table, reason: `empties ${schema}.${table}, which cannot be undone` }
  }
}

/** Drop from the tree, the same way. */
export function dropWrite(
  schema: string,
  name: string,
  type: 'table' | 'view',
  database: string
): WriteItem {
  return {
    description: `DROP ${type === 'view' ? 'VIEW' : 'TABLE'} removes ${schema}.${name}`,
    database,
    danger: { name, reason: `drops ${schema}.${name}, which cannot be undone` }
  }
}

/**
 * Whether what was typed names the thing about to go.
 *
 * Case does not count — SQL Server's names mostly do not either — and nor
 * does space around it, but the whole name has to be there.
 */
export function namesIt(typed: string, name: string): boolean {
  return typed.trim().toLowerCase() === name.toLowerCase()
}
