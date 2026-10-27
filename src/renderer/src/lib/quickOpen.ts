/**
 * Quick open (`Ctrl+P`): every table, view, routine and saved query by name,
 * matched as you type and ranked so the likely one is first.
 *
 * Everything it lists is already in the window — the schema store holds the
 * objects and routines, the library holds the saved queries — so nothing here
 * asks the server, and a window with no tree on screen can still use it.
 */
import type {
  RoutineObject,
  RoutineType,
  SavedQuery,
  SchemaObject,
  SchemaObjectType
} from '@shared/types'

export type QuickOpenKind = 'table' | 'view' | 'procedure' | 'function' | 'query'

export interface QuickOpenItem {
  /** Stable across schema reads: `object:dbo.orders`, `routine:dbo.usp`, `query:<id>`. */
  key: string
  kind: QuickOpenKind
  name: string
  /** Absent for a saved query, which belongs to no schema. */
  schema?: string
  rowCountEstimate?: number
  objectType?: SchemaObjectType
  routineType?: RoutineType
  savedQueryId?: string
  pinned: boolean
}

export interface QuickOpenMatch {
  item: QuickOpenItem
  score: number
  /** Matched characters, as indexes into `name`, for drawing them stronger. */
  namePositions: number[]
  /** …and into `schema`, when the query named it. */
  schemaPositions: number[]
}

export function objectKey(schema: string, name: string): string {
  return `object:${schema}.${name}`
}

export function routineKey(schema: string, name: string): string {
  return `routine:${schema}.${name}`
}

export function queryKey(id: string): string {
  return `query:${id}`
}

/** Every item the palette can open, from what the stores already hold. */
export function quickOpenItems(
  objects: SchemaObject[],
  routines: RoutineObject[],
  savedQueries: SavedQuery[],
  pinned: string[]
): QuickOpenItem[] {
  const isPinned = new Set(pinned)
  return [
    ...objects.map(
      (object): QuickOpenItem => ({
        key: objectKey(object.schema, object.name),
        kind: object.type === 'view' ? 'view' : 'table',
        name: object.name,
        schema: object.schema,
        rowCountEstimate: object.rowCountEstimate,
        objectType: object.type,
        pinned: isPinned.has(`${object.schema}.${object.name}`)
      })
    ),
    ...routines.map(
      (routine): QuickOpenItem => ({
        key: routineKey(routine.schema, routine.name),
        kind: routine.type === 'procedure' ? 'procedure' : 'function',
        name: routine.name,
        schema: routine.schema,
        routineType: routine.type,
        pinned: false
      })
    ),
    ...savedQueries.map(
      (query): QuickOpenItem => ({
        key: queryKey(query.id),
        kind: 'query',
        name: query.name,
        savedQueryId: query.id,
        pinned: false
      })
    )
  ]
}

/** A position that starts a word: the first character, or one after `_`, `.`, `-`, a space or a lower-to-upper step. */
function startsWord(text: string, index: number): boolean {
  if (index === 0) return true
  const before = text[index - 1]
  if ('_.- '.includes(before)) return true
  const here = text[index]
  return before === before.toLowerCase() && here !== here.toLowerCase()
}

/**
 * How well `query` matches `text`, and which characters it matched; null when
 * its characters do not all appear in order.
 *
 * Whole name, then a prefix, then the initials of its words, then a run of
 * characters together, then characters scattered through — with the ones
 * that start a word counting for more.
 */
export function fuzzyMatch(query: string, text: string): { score: number; positions: number[] } | null {
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  if (needle === '') return { score: 0, positions: [] }

  const range = (from: number): number[] =>
    Array.from({ length: needle.length }, (_, index) => from + index)

  if (haystack === needle) return { score: 1000, positions: range(0) }
  if (haystack.startsWith(needle)) {
    return { score: 800 - (haystack.length - needle.length), positions: range(0) }
  }
  const at = haystack.indexOf(needle)
  if (at >= 0) {
    const boundary = startsWord(text, at) ? 100 : 0
    return {
      score: 500 + boundary - at - (haystack.length - needle.length) * 0.5,
      positions: range(at)
    }
  }

  // Scattered: each character taken at the next word start that has it if
  // there is one before the next plain occurrence, so acronyms line up.
  const positions: number[] = []
  let from = 0
  let score = 200
  for (const char of needle) {
    let found = -1
    let plain = -1
    for (let index = from; index < haystack.length; index += 1) {
      if (haystack[index] !== char) continue
      if (plain < 0) plain = index
      if (startsWord(text, index)) {
        found = index
        break
      }
    }
    if (found < 0) found = plain
    if (found < 0) return null
    const previous = positions[positions.length - 1]
    if (startsWord(text, found)) score += 15
    if (previous !== undefined && found === previous + 1) score += 10
    score -= previous === undefined ? found : found - previous - 1
    positions.push(found)
    from = found + 1
  }
  // Every letter starting a word, from the first: an acronym, which is meant
  // as surely as a name typed out — `oi` is `order_items`, not `invoice`.
  if (positions[0] === 0 && positions.every((index) => startsWord(text, index))) {
    return { score: 650 - (haystack.length - needle.length) * 0.5, positions }
  }
  return { score: Math.max(1, score - (haystack.length - needle.length) * 0.25), positions }
}

/** How much being pinned, or recently opened, lifts an item over its match alone. */
const PINNED_BONUS = 150
const RECENT_BONUS = 120

/** The order nothing typed lists things in, after pinned and recent ones. */
const KIND_ORDER: Record<QuickOpenKind, number> = {
  table: 0,
  view: 1,
  procedure: 2,
  function: 3,
  query: 4
}

function matchItem(item: QuickOpenItem, query: string): QuickOpenMatch | null {
  const onName = fuzzyMatch(query, item.name)
  if (onName) return { item, score: onName.score, namePositions: onName.positions, schemaPositions: [] }
  if (!item.schema || !query.includes('.')) return null

  // `sales.ord` names the schema as well: matched over the qualified name,
  // and told apart again for drawing.
  const qualified = `${item.schema}.${item.name}`
  const onQualified = fuzzyMatch(query, qualified)
  if (!onQualified) return null
  const split = item.schema.length + 1
  return {
    item,
    score: onQualified.score,
    schemaPositions: onQualified.positions.filter((index) => index < item.schema!.length),
    namePositions: onQualified.positions.filter((index) => index >= split).map((index) => index - split)
  }
}

/**
 * The items to list for `query`, best first.
 *
 * With nothing typed: pinned tables, then what was opened most recently, then
 * the rest by kind and name. With something typed: by how well it matches,
 * pinned and recent ones lifted, ties going to the shorter name.
 */
export function rankQuickOpen(
  items: QuickOpenItem[],
  query: string,
  recent: string[],
  limit = 60
): QuickOpenMatch[] {
  const needle = query.trim()
  const recency = new Map(recent.map((key, index) => [key, index]))

  if (needle === '') {
    const rank = (item: QuickOpenItem): number =>
      item.pinned ? -2000 : recency.has(item.key) ? -1000 + recency.get(item.key)! : 0
    return [...items]
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          a.name.localeCompare(b.name) ||
          (a.schema ?? '').localeCompare(b.schema ?? '')
      )
      .slice(0, limit)
      .map((item) => ({ item, score: 0, namePositions: [], schemaPositions: [] }))
  }

  const matches: QuickOpenMatch[] = []
  for (const item of items) {
    const match = matchItem(item, needle)
    if (!match) continue
    if (item.pinned) match.score += PINNED_BONUS
    const seen = recency.get(item.key)
    if (seen !== undefined) match.score += RECENT_BONUS - Math.min(seen, 20) * 3
    matches.push(match)
  }
  return matches
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.name.length - b.item.name.length ||
        a.item.name.localeCompare(b.item.name)
    )
    .slice(0, limit)
}

/** Most recent first, each once, and no more than `cap` of them. */
export function touchRecent(recent: string[], key: string, cap = 30): string[] {
  return [key, ...recent.filter((entry) => entry !== key)].slice(0, cap)
}
