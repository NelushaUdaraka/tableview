/**
 * Which of a table's columns the grid shows.
 *
 * A table tab keeps the names of the columns taken out of its grid rather than
 * of those left in, so a column added to the table later turns up like any
 * other instead of being missing from a list it was never on. A name that
 * matches nothing — a column since dropped — hides nothing.
 *
 * Hiding asks the server nothing. The page is read whole whatever is on show:
 * a row is still identified by its key, edited and counted as it was, and a
 * column put back has its values already there.
 */

interface Named {
  name: string
}

/** Positions in `columns` of the ones `hidden` names. */
export function hiddenColumnIndexes(columns: readonly Named[], hidden: readonly string[]): number[] {
  if (hidden.length === 0) return []
  const names = new Set(hidden)
  return columns.flatMap((column, index) => (names.has(column.name) ? [index] : []))
}

/** Positions of the rest, in order: what the grid draws. */
export function shownColumnIndexes(columns: readonly Named[], hidden: readonly string[]): number[] {
  const names = new Set(hidden)
  return columns.flatMap((column, index) => (names.has(column.name) ? [] : [index]))
}

/** `hidden` with these columns put back. */
export function showColumns(hidden: readonly string[], names: readonly string[]): string[] {
  const shown = new Set(names)
  return hidden.filter((name) => !shown.has(name))
}

/** `hidden` with these columns taken out as well. */
export function hideColumns(hidden: readonly string[], names: readonly string[]): string[] {
  const next = [...hidden]
  for (const name of names) if (!next.includes(name)) next.push(name)
  return next
}

/** `hidden` with one column shown or hidden. */
export function setColumnShown(hidden: readonly string[], name: string, shown: boolean): string[] {
  return shown ? showColumns(hidden, [name]) : hideColumns(hidden, [name])
}

/** The columns whose names hold what was typed, whatever its case; all of them for nothing. */
export function matchColumns<T extends Named>(columns: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...columns]
  return columns.filter((column) => column.name.toLowerCase().includes(needle))
}

/**
 * A page cut down to the columns at `shown` — what a copy or an export of the
 * grid holds, so what leaves the window is what was on screen. With every
 * column on show it is handed back as it was, uncopied.
 */
export function pickColumns<C, V>(
  columns: readonly C[],
  rows: readonly (readonly V[])[],
  shown: readonly number[]
): { columns: C[]; rows: V[][] } {
  if (shown.length === columns.length) {
    return { columns: columns as C[], rows: rows as V[][] }
  }
  return {
    columns: shown.map((index) => columns[index]),
    rows: rows.map((row) => shown.map((index) => row[index]))
  }
}
