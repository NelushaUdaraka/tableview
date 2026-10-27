/**
 * Where the editor offers snippets: a word being typed in code — not after a
 * `.`, which names a column, nor an `@variable` or a `#temp` table, and not in
 * a comment or a string.
 */
import { isCodeAt } from '@shared/sql/statements'

const WORD = /[\p{L}\p{N}_]/u

/** Where the snippet's prefix starts, or null when no snippet goes at `pos`. */
export function snippetFrom(doc: string, pos: number, explicit: boolean): number | null {
  if (!isCodeAt(doc, pos)) return null
  let from = pos
  while (from > 0 && WORD.test(doc[from - 1])) from -= 1
  const before = doc[from - 1]
  if (before === '.' || before === '@' || before === '#' || before === '$') return null
  if (from === pos && !explicit) return null
  return from
}
