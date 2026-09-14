/**
 * The JSON a text cell is holding, when that is what it is holding.
 *
 * SQL Server has no JSON type: a document lives in an `nvarchar(max)` column
 * like any other string, and comes back as one long line — which is the one
 * shape the row panel cannot help with, since every value there is already
 * given as much room as it asks for. What the reader wants of a document is
 * its shape, so it is offered as a tree instead, and the text is a click away.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface JsonEntry {
  key: string
  value: JsonValue
}

/**
 * How much text is worth trying to parse.
 *
 * Parsing is cheap; the tree built from a document of this size is not, and it
 * would be built on every keystroke that reaches the panel. Past this the raw
 * text is what the field shows, which is what it showed before any of this.
 */
export const MAX_JSON_LENGTH = 1_000_000

/**
 * Parses a cell's text as a JSON object or array, or reports that it is not one.
 *
 * Only those two: a bare `42`, `"done"` or `true` is valid JSON, and a tree of
 * one line says nothing the field did not already say — worse, it would turn
 * every number and every `true` in the table into a "document".
 */
export function parseJsonCell(text: string): JsonValue | null {
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed.length > MAX_JSON_LENGTH) return null

  const opens = trimmed[0] === '{' ? '}' : trimmed[0] === '[' ? ']' : null
  if (opens === null || trimmed[trimmed.length - 1] !== opens) return null

  try {
    const value: unknown = JSON.parse(trimmed)
    return isContainer(value as JsonValue) ? (value as JsonValue) : null
  } catch {
    return null
  }
}

/** Whether a value has anything inside it — an object or an array. */
export function isContainer(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null
}

/** What is inside a container, as the rows the tree draws: arrays by index. */
export function entriesOf(value: JsonValue): JsonEntry[] {
  if (Array.isArray(value)) return value.map((entry, index) => ({ key: String(index), value: entry }))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([key, entry]) => ({ key, value: entry }))
  }
  return []
}

/** A closed container, summarised by how much it holds: `{3}`, `[12]`, `{}`. */
export function previewOf(value: JsonValue): string {
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  const size = entriesOf(value).length
  return size === 0 ? `${open}${close}` : `${open}${size}${close}`
}

export type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'container'

export function kindOf(value: JsonValue): JsonKind {
  if (value === null) return 'null'
  if (isContainer(value)) return 'container'
  const type = typeof value
  return type === 'string' || type === 'number' || type === 'boolean' ? type : 'string'
}

/** A scalar as JSON writes it, so a string is visibly a string. */
export function scalarText(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/**
 * How deep the tree opens on its own.
 *
 * The top level and the one under it: enough to see the shape of a document
 * without a click, and not so much that a nested array of rows fills the panel
 * before the reader has asked it to.
 */
export const DEFAULT_OPEN_DEPTH = 2
