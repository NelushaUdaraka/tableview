/**
 * Snippets: short, reusable pieces of T-SQL the editor's completion inserts.
 *
 * A snippet has a name, a prefix that brings it up in completion, and a body
 * whose `${1:name}` placeholders Tab moves between — CodeMirror's snippet
 * syntax, which is what inserts it. Everything here is pure and shared: the
 * main process keeps the list in `snippets.json` and reads and writes the
 * files a team passes around; the window checks an edit before it is saved.
 */
import type { Snippet } from './types'

export const SNIPPET_EXPORT_KIND = 'tableview/snippets'
export const SNIPPET_EXPORT_VERSION = 1

/** A snippet as a file carries it: what it is, not which machine's list it sat in. */
export type ExportedSnippet = Omit<Snippet, 'id'>

export interface SnippetExportFile {
  kind: typeof SNIPPET_EXPORT_KIND
  version: number
  exportedAt: string
  snippets: ExportedSnippet[]
}

export interface SnippetImportSummary {
  added: string[]
  /** Prefixes already in the list, whose snippet the file's replaced. */
  replaced: string[]
}

/**
 * The set a new install starts with: the boilerplate T-SQL is typed over and
 * over. Their ids are fixed, so a starter put back is the same snippet again.
 */
export const STARTER_SNIPPETS: readonly Snippet[] = [
  {
    id: 'starter-tran',
    name: 'Guarded transaction',
    prefix: 'tran',
    description: 'Runs the statements in a transaction that rolls back until you say otherwise.',
    body: 'BEGIN TRAN;\n\n${1:-- statements}\n\n-- Look at the results, then swap these two lines to keep them.\nROLLBACK;\n-- COMMIT;'
  },
  {
    id: 'starter-trycatch',
    name: 'TRY…CATCH with a transaction',
    prefix: 'trycatch',
    description: 'Commits when every statement succeeds, and rolls back and rethrows when one fails.',
    body:
      'BEGIN TRY\n    BEGIN TRAN;\n\n    ${1:-- statements}\n\n    COMMIT;\nEND TRY\n' +
      'BEGIN CATCH\n    IF @@TRANCOUNT > 0 ROLLBACK;\n    THROW;\nEND CATCH;'
  },
  {
    id: 'starter-droptable',
    name: 'Drop a table if it exists',
    prefix: 'droptable',
    description: 'Works on every SQL Server version, unlike DROP TABLE IF EXISTS.',
    body: "IF OBJECT_ID(N'${1:dbo.table}', N'U') IS NOT NULL\n    DROP TABLE ${1:dbo.table};"
  },
  {
    id: 'starter-temp',
    name: 'Temp table',
    prefix: 'temptable',
    description: 'Drops the temp table if an earlier run left it, then creates it.',
    body:
      "IF OBJECT_ID(N'tempdb..#${1:work}') IS NOT NULL DROP TABLE #${1:work};\n\n" +
      'CREATE TABLE #${1:work} (\n    ${2:id int NOT NULL PRIMARY KEY}\n);'
  },
  {
    id: 'starter-page',
    name: 'Paging query',
    prefix: 'page',
    description: 'One page of rows, with OFFSET … FETCH.',
    body:
      'SELECT ${1:*}\nFROM ${2:dbo.table}\nORDER BY ${3:id}\n' +
      'OFFSET ${4:0} ROWS FETCH NEXT ${5:100} ROWS ONLY;'
  },
  {
    id: 'starter-cte',
    name: 'Common table expression',
    prefix: 'cte',
    body: 'WITH ${1:cte} AS (\n    ${2:SELECT 1 AS n}\n)\nSELECT *\nFROM ${1:cte};'
  }
]

/** The starters not in the list — deleted, or with their prefix taken by another — to put back. */
export function missingStarters(snippets: readonly Snippet[]): Snippet[] {
  return STARTER_SNIPPETS.filter(
    (starter) =>
      !snippets.some(
        (s) => s.id === starter.id || s.prefix.trim().toLowerCase() === starter.prefix.toLowerCase()
      )
  )
}

const FIELD = /[#$]\{(?:(\d+)(?::([^{}]*))?|((?:\\[{}]|[^{}])*))\}/g

/**
 * The body as it would be inserted, each placeholder showing its text — for
 * the list and for the completion's preview.
 */
export function snippetPreview(body: string): string {
  return body
    .replace(FIELD, (_match, _seq, named, bare) => (named ?? bare ?? '').replace(/\\([{}])/g, '$1'))
    .replace(/\\([{}])/g, '$1')
}

/** A prefix is one word: completion matches it against what is being typed. */
export const PREFIX_PATTERN = /^[\p{L}\p{N}_]+$/u

/** What is wrong with a snippet, given the list it is going into; null when nothing. */
export function snippetProblem(snippet: Snippet, all: readonly Snippet[]): string | null {
  if (!snippet.name.trim()) return 'Give the snippet a name.'
  const prefix = snippet.prefix.trim()
  if (!prefix) return 'Give the snippet a prefix: the word that brings it up in completion.'
  if (!PREFIX_PATTERN.test(prefix)) return 'A prefix is one word: letters, digits and underscores.'
  if (!snippet.body.trim()) return 'The snippet has no text.'
  const clash = all.find(
    (other) => other.id !== snippet.id && other.prefix.trim().toLowerCase() === prefix.toLowerCase()
  )
  if (clash) return `“${clash.name}” already uses the prefix ${prefix}.`
  return null
}

/** Tidies what was typed: trimmed name and prefix, an empty description dropped. */
export function normalizeSnippet(snippet: Snippet): Snippet {
  const description = snippet.description?.trim()
  return {
    id: snippet.id,
    name: snippet.name.trim(),
    prefix: snippet.prefix.trim(),
    body: snippet.body.replace(/\r\n?/g, '\n'),
    ...(description ? { description } : {})
  }
}

export function snippetExportFile(snippets: readonly Snippet[], now = new Date()): SnippetExportFile {
  return {
    kind: SNIPPET_EXPORT_KIND,
    version: SNIPPET_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    snippets: snippets.map(({ id: _id, ...rest }) => rest)
  }
}

export function snippetExportFileName(now = new Date()): string {
  return `tableview-snippets-${now.toISOString().slice(0, 10)}.json`
}

/** Reads an exported file, refusing anything that is not one. */
export function parseSnippetFile(contents: string): ExportedSnippet[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error('That file is not JSON, so it cannot be a snippets export.')
  }
  const file = parsed as Partial<SnippetExportFile> | null
  if (!file || file.kind !== SNIPPET_EXPORT_KIND || !Array.isArray(file.snippets)) {
    throw new Error('That file is not a TableView snippets export.')
  }
  if (typeof file.version === 'number' && file.version > SNIPPET_EXPORT_VERSION) {
    throw new Error('That file comes from a newer TableView. Update this one to import it.')
  }
  const out: ExportedSnippet[] = []
  for (const entry of file.snippets) {
    const record = entry as Partial<ExportedSnippet> | null
    if (
      !record ||
      typeof record.name !== 'string' ||
      typeof record.prefix !== 'string' ||
      typeof record.body !== 'string'
    ) {
      continue
    }
    out.push({
      name: record.name,
      prefix: record.prefix,
      body: record.body,
      ...(typeof record.description === 'string' ? { description: record.description } : {})
    })
  }
  return out
}

/**
 * The list after an import: a snippet whose prefix is already taken replaces
 * the one there (keeping its id), and the rest are added. Snippets the file
 * holds that could not be saved — no name, a prefix of two words — are left
 * out, as is a second one with a prefix the file already used.
 */
export function mergeSnippets(
  current: readonly Snippet[],
  incoming: readonly ExportedSnippet[],
  newId: () => string
): { snippets: Snippet[]; summary: SnippetImportSummary } {
  const snippets = [...current]
  const summary: SnippetImportSummary = { added: [], replaced: [] }
  const taken = new Set<string>()
  for (const entry of incoming) {
    const key = entry.prefix.trim().toLowerCase()
    if (taken.has(key)) continue
    const index = snippets.findIndex((s) => s.prefix.trim().toLowerCase() === key)
    const record = normalizeSnippet({ ...entry, id: index >= 0 ? snippets[index].id : newId() })
    if (snippetProblem(record, snippets)) continue
    taken.add(key)
    if (index >= 0) {
      snippets[index] = record
      summary.replaced.push(record.prefix)
    } else {
      snippets.push(record)
      summary.added.push(record.prefix)
    }
  }
  return { snippets, summary }
}
