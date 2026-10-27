/**
 * The SQL shown to be read — the statements Apply will send — highlighted by
 * the editor's own T-SQL grammar, as runs of text tagged with what they are.
 */
import { describe, expect, it } from 'vitest'
import { highlightSql, type SqlPiece } from '../../../src/renderer/src/lib/sqlHighlight'

const tokenOf = (pieces: SqlPiece[], text: string): string | null | undefined =>
  pieces.find((piece) => piece.text.trim() === text)?.token

describe('highlightSql', () => {
  const statement =
    "INSERT INTO [dbo].[orders] ([status], [total]) VALUES\n  (N'new', 12.50),\n  (NULL, 3) -- two rows"
  const pieces = highlightSql(statement)

  it('puts back exactly the text it was given, line breaks included', () => {
    expect(pieces.map((piece) => piece.text).join('')).toBe(statement)
  })

  it('tells keywords, strings, numbers and comments apart, as the editor does', () => {
    expect(tokenOf(pieces, 'INSERT')).toBe('keyword')
    expect(tokenOf(pieces, 'VALUES')).toBe('keyword')
    expect(tokenOf(pieces, 'NULL')).toBe('keyword')
    expect(tokenOf(pieces, "'new'")).toBe('string')
    expect(tokenOf(pieces, '12.50')).toBe('number')
    expect(tokenOf(pieces, '-- two rows')).toBe('comment')
  })

  it('never takes a bracketed name for a keyword, whatever word is inside it', () => {
    const [name] = highlightSql('UPDATE [select] SET [from] = 1').filter((piece) =>
      piece.text.includes('[select]')
    )
    expect(name.token).not.toBe('keyword')
  })

  it('reads a binary literal and a date literal the way an export writes them', () => {
    const literals = highlightSql("UPDATE t SET b = 0xff00, d = '2024-03-01T10:00:00.000'")
    expect(tokenOf(literals, "'2024-03-01T10:00:00.000'")).toBe('string')
    expect(tokenOf(literals, '0xff00')).toBe('number')
  })
})
