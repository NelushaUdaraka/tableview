/**
 * T-SQL in the window's syntax palette, wherever it is shown — in the editor,
 * and in the SQL the app shows to be read: the statements Apply will send,
 * and the ones a confirm-writes connection asks about.
 *
 * One table says which highlighting tags are which kind of token, and both
 * the editor's style and the static code read it, so a keyword is the same
 * colour in the dialog as in the editor it would be typed into. The static
 * code is parsed by the editor's own T-SQL grammar, not a second guess at it.
 */
import { MSSQL } from '@codemirror/lang-sql'
import { highlightCode, tagHighlighter, tags, type Tag } from '@lezer/highlight'

export type SqlToken =
  | 'keyword'
  | 'function'
  | 'string'
  | 'number'
  | 'comment'
  | 'name'
  | 'type'
  | 'operator'
  | 'punctuation'
  | 'invalid'

/** Which tags are which kind of token. The first match wins, so specific tags come first. */
export const SQL_TOKENS: readonly { tag: Tag | readonly Tag[]; token: SqlToken }[] = [
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], token: 'keyword' },
  { tag: [tags.controlKeyword, tags.definitionKeyword], token: 'keyword' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], token: 'function' },
  { tag: [tags.string, tags.special(tags.string)], token: 'string' },
  { tag: [tags.number, tags.bool, tags.null], token: 'number' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], token: 'comment' },
  { tag: [tags.variableName, tags.propertyName, tags.name], token: 'name' },
  { tag: [tags.typeName, tags.className], token: 'type' },
  { tag: tags.operator, token: 'operator' },
  { tag: [tags.punctuation, tags.separator, tags.bracket], token: 'punctuation' },
  { tag: tags.invalid, token: 'invalid' }
]

/** Each kind of token's colour, from the --syntax-* tokens in the stylesheet. */
export const SQL_TOKEN_COLORS: Record<SqlToken, string> = {
  keyword: 'var(--syntax-keyword)',
  function: 'var(--syntax-function)',
  string: 'var(--syntax-string)',
  number: 'var(--syntax-number)',
  comment: 'var(--syntax-comment)',
  name: 'var(--text-primary)',
  type: 'var(--syntax-type)',
  operator: 'var(--text-secondary)',
  punctuation: 'var(--text-muted)',
  invalid: 'var(--danger)'
}

export interface SqlPiece {
  text: string
  /** Null for whitespace, and for text the grammar gives no tag. */
  token: SqlToken | null
}

const highlighter = tagHighlighter(SQL_TOKENS.map(({ tag, token }) => ({ tag, class: token })))
const parser = MSSQL.language.parser

/**
 * SQL as runs of text, each with the kind of token it is. Line breaks stay in
 * the text, so the pieces put together are exactly what was given.
 */
export function highlightSql(text: string): SqlPiece[] {
  const pieces: SqlPiece[] = []
  const put = (piece: string, token: SqlToken | null): void => {
    const last = pieces[pieces.length - 1]
    if (last && last.token === token) last.text += piece
    else pieces.push({ text: piece, token })
  }
  highlightCode(
    text,
    parser.parse(text),
    highlighter,
    (piece, classes) => put(piece, (classes.split(' ')[0] || null) as SqlToken | null),
    () => put('\n', null)
  )
  return pieces
}
