/**
 * Staged table edits as the statements Apply sends, with their values written
 * in — to read before applying, and to keep as a script.
 *
 * Built from the same change set by the same builders, in the same order, as
 * the main process (`buildChangeSetStatements`), so what is shown is what is
 * sent. Only the values differ: Apply still binds them as parameters, and the
 * literals here are for reading and copying.
 */
import { sqlLiteral } from '../export'
import type { TableChangeSet } from '../types'
import { BuiltQuery, buildChangeSetStatements } from './builder'

/** A bracketed name, a string literal, or a parameter — in that order of precedence. */
const TOKENS = /\[(?:[^\]]|\]\])*\]|'(?:[^']|'')*'|@(\w+)/g

/** A built statement with each `@pN` replaced by its value as a literal. */
export function inlineParams(query: BuiltQuery): string {
  const values = new Map(query.params.map((param) => [param.name, param.value]))
  return query.sql.replace(TOKENS, (token, name: string | undefined) =>
    name !== undefined && values.has(name) ? sqlLiteral(values.get(name)!) : token
  )
}

/** Every statement Apply would send, in order, each ending in `;`. */
export function changeSetStatements(changeSet: TableChangeSet): string[] {
  return buildChangeSetStatements(changeSet).map((query) => `${inlineParams(query)};`)
}

function count(n: number, noun: string): string {
  return n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * The statements as a script that runs on its own: one transaction, which
 * `XACT_ABORT` rolls back at the first error — all or nothing, as Apply is.
 */
export function changeSetScript(changeSet: TableChangeSet): string {
  const summary = [
    count(changeSet.deletes.length, 'delete'),
    count(changeSet.updates.length, 'update'),
    count(changeSet.inserts.length, 'insert')
  ]
    .filter(Boolean)
    .join(', ')
  return [
    `-- Staged edits to ${changeSet.schema}.${changeSet.table}: ${summary}`,
    'SET XACT_ABORT ON;',
    'BEGIN TRANSACTION;',
    '',
    ...changeSetStatements(changeSet),
    '',
    'COMMIT TRANSACTION;',
    ''
  ].join('\n')
}
