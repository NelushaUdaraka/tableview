/**
 * Index bookkeeping for staged inserts.
 *
 * The grid addresses every row by one number: stored rows first, then staged
 * inserts. Staged edits are keyed by that number, so removing a staged insert
 * from the middle shifts every one after it — and their values would land on
 * their neighbours unless the keys move with them.
 */
import type { CellValue } from '@shared/types'

/** Staged edits, keyed `rowIndex:columnIndex`. */
export type StagedEdits = Record<string, CellValue>

export function rowIndexOf(key: string): number {
  return Number(key.split(':')[0])
}

/**
 * Rebuilds the edits for staged rows after some of them have been removed.
 *
 * `keptNewIndexes` is the surviving rows' positions in the old staged list, in
 * order. Edits on stored rows are returned untouched; edits belonging to rows
 * that went away are dropped.
 */
export function reindexStagedEdits(
  edits: StagedEdits,
  loadedCount: number,
  keptNewIndexes: number[]
): StagedEdits {
  const next: StagedEdits = {}

  for (const [key, value] of Object.entries(edits)) {
    if (rowIndexOf(key) < loadedCount) next[key] = value
  }

  keptNewIndexes.forEach((oldNewIndex, position) => {
    const from = loadedCount + oldNewIndex
    const to = loadedCount + position
    for (const [key, value] of Object.entries(edits)) {
      const [rowText, columnText] = key.split(':')
      if (Number(rowText) === from) next[`${to}:${columnText}`] = value
    }
  })

  return next
}
