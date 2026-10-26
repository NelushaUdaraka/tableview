/**
 * Finding text in the definitions the server keeps: procedures, functions,
 * views and triggers.
 *
 * The server narrows the search to the objects whose definition contains the
 * text (`LIKE`, which is all it can do cheaply); the lines worth showing are
 * found here, where whole-word matching and the excerpt around each match are
 * easy. What is found here is the answer: an object the server let through
 * with no line matching here — an accent folded by the collation, say — is
 * left out rather than shown with nothing under it.
 */
import type { DefinitionMatchLine, ModuleKind, ModuleType } from '../types'
import { escapeLikePattern } from './identifiers'

export interface LineMatchOptions {
  matchCase?: boolean
  wholeWord?: boolean
  /** Lines kept per object; the rest are only counted. */
  maxLines?: number
}

/** What makes up a T-SQL identifier, so a whole word stops at anything else. */
const WORD = '[\\p{L}\\p{N}_@#$]'

/** Longest excerpt of one line, so a definition written on a single line still reads. */
const MAX_EXCERPT = 240
/** How much of the line before the first match an excerpt keeps. */
const LEAD = 40

/** The `LIKE` pattern for text anywhere in a definition; pair with `ESCAPE '\'`. */
export function containsPattern(text: string): string {
  return `%${escapeLikePattern(text)}%`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matcherFor(text: string, options: LineMatchOptions = {}): RegExp {
  const body = escapeRegExp(text)
  const source = options.wholeWord ? `(?<!${WORD})${body}(?!${WORD})` : body
  return new RegExp(source, options.matchCase ? 'gu' : 'giu')
}

/**
 * The part of a line to show: without its indentation, and cut down around the
 * first match when it is long. Ranges move with the text, and any that fall
 * outside it are dropped.
 */
function excerpt(
  line: string,
  ranges: [number, number][]
): Pick<DefinitionMatchLine, 'text' | 'ranges'> {
  const indent = line.length - line.trimStart().length
  let start = indent
  let end = line.trimEnd().length
  if (end - start > MAX_EXCERPT) {
    start = Math.max(start, ranges[0][0] - LEAD)
    end = Math.min(end, start + MAX_EXCERPT)
  }
  const prefix = start > indent ? '…' : ''
  const suffix = end < line.trimEnd().length ? '…' : ''
  const shift = prefix.length - start
  const kept = ranges
    .filter(([from]) => from >= start && from < end)
    .map(([from, to]): [number, number] => [from + shift, Math.min(to, end) + shift])
  return { text: prefix + line.slice(start, end) + suffix, ranges: kept }
}

/** The lines of `definition` that contain `text`, numbered from 1. */
export function matchingLines(
  definition: string,
  text: string,
  options: LineMatchOptions = {}
): { lines: DefinitionMatchLine[]; moreLines: number } {
  const maxLines = options.maxLines ?? 50
  const lines: DefinitionMatchLine[] = []
  let moreLines = 0
  if (!text) return { lines, moreLines }

  const matcher = matcherFor(text, options)
  // The editor breaks lines on all three, so the numbers agree with it.
  definition.split(/\r\n|\r|\n/).forEach((line, index) => {
    const ranges: [number, number][] = []
    for (const match of line.matchAll(matcher)) {
      ranges.push([match.index, match.index + match[0].length])
    }
    if (ranges.length === 0) return
    if (lines.length >= maxLines) {
      moreLines += 1
      return
    }
    lines.push({ line: index + 1, ...excerpt(line, ranges) })
  })
  return { lines, moreLines }
}

/** What a `sys.objects` type code is, for the modules a search can find. */
export function moduleTypeOf(code: string): ModuleType | null {
  switch (code.trim().toUpperCase()) {
    case 'P':
      return 'procedure'
    case 'FN':
      return 'scalar-function'
    case 'IF':
    case 'TF':
      return 'table-function'
    case 'V':
      return 'view'
    case 'TR':
      return 'trigger'
    default:
      return null
  }
}

export function moduleKindOf(type: ModuleType): ModuleKind {
  return type === 'scalar-function' || type === 'table-function' ? 'function' : type
}
