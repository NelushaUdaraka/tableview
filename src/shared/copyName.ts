/**
 * What to call the copy a duplicated connection becomes.
 *
 * Duplicating is how one connection turns into a variant of another — copy
 * production, point it at staging, keep both — so the two sit side by side in
 * the list with nothing but the name to tell them apart. Appending "(copy)"
 * blindly is no good for that: duplicating the copy gives "Prod (copy) (copy)",
 * and duplicating the original twice gives two entries called "Prod (copy)".
 * Numbering from the stem keeps every name in the list distinct and short.
 */

/** A trailing ` (copy)` or ` (copy 7)`, however it was capitalised. */
const COPY_SUFFIX = /\s*\(copy(?:\s+\d+)?\)$/i

/** What a copy is a copy of: `Prod (copy 3)` → `Prod`. */
export function copyStem(name: string): string {
  const trimmed = name.trim()
  // A connection genuinely called "(copy)" keeps that as its stem rather than
  // being stripped down to nothing.
  return trimmed.replace(COPY_SUFFIX, '').trim() || trimmed
}

/**
 * The first free name in the `Prod (copy)`, `Prod (copy 2)`, … series.
 *
 * `taken` is compared trimmed and case-insensitively, because two connections
 * whose names differ only in case are two names nobody can tell apart.
 */
export function copyNameFor(name: string, taken: Iterable<string> = []): string {
  const stem = copyStem(name)
  const used = new Set(Array.from(taken, (entry) => entry.trim().toLowerCase()))

  for (let attempt = 1; ; attempt++) {
    const candidate = `${stem} ${attempt === 1 ? '(copy)' : `(copy ${attempt})`}`.trim()
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
