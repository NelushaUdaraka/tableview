/**
 * Snippets: the starter set, checking an edit, and the file a team shares.
 */
import { describe, expect, it } from 'vitest'
import {
  STARTER_SNIPPETS,
  mergeSnippets,
  missingStarters,
  parseSnippetFile,
  snippetExportFile,
  snippetPreview,
  snippetProblem
} from '../../src/shared/snippets'
import type { Snippet } from '../../src/shared/types'

const snippet = (patch: Partial<Snippet> = {}): Snippet => ({
  id: 'a',
  name: 'Name',
  prefix: 'pre',
  body: 'SELECT 1;',
  ...patch
})

describe('the starter set', () => {
  it('has distinct ids and prefixes, and every one passes its own check', () => {
    expect(new Set(STARTER_SNIPPETS.map((s) => s.id)).size).toBe(STARTER_SNIPPETS.length)
    for (const starter of STARTER_SNIPPETS) {
      expect(snippetProblem(starter, STARTER_SNIPPETS)).toBeNull()
    }
  })

  it('includes the guarded transaction the issue asked for', () => {
    const tran = STARTER_SNIPPETS.find((s) => s.prefix === 'tran')
    expect(snippetPreview(tran!.body)).toMatch(/^BEGIN TRAN;[\s\S]*ROLLBACK;\n-- COMMIT;$/)
  })

  it('lists the starters missing from a list, by id or by prefix', () => {
    const list = [STARTER_SNIPPETS[0], snippet({ id: 'x', prefix: STARTER_SNIPPETS[1].prefix.toUpperCase() })]
    expect(missingStarters(list).map((s) => s.id)).toEqual(STARTER_SNIPPETS.slice(2).map((s) => s.id))
  })
})

describe('snippetPreview', () => {
  it('shows each placeholder as its text', () => {
    expect(snippetPreview('SELECT ${1:cols} FROM ${2:t} WHERE ${id} = ${0}')).toBe(
      'SELECT cols FROM t WHERE id = '
    )
    expect(snippetPreview("OBJECT_ID(N'tempdb..#${1:work}')")).toBe("OBJECT_ID(N'tempdb..#work')")
    expect(snippetPreview('a \\{b\\} c')).toBe('a {b} c')
  })
})

describe('snippetProblem', () => {
  it('asks for a name, a one-word prefix and some text', () => {
    expect(snippetProblem(snippet({ name: ' ' }), [])).toMatch(/name/)
    expect(snippetProblem(snippet({ prefix: '' }), [])).toMatch(/prefix/)
    expect(snippetProblem(snippet({ prefix: 'two words' }), [])).toMatch(/one word/)
    expect(snippetProblem(snippet({ prefix: 'a.b' }), [])).toMatch(/one word/)
    expect(snippetProblem(snippet({ body: '\n' }), [])).toMatch(/no text/)
    expect(snippetProblem(snippet({ prefix: 'sel_2' }), [])).toBeNull()
  })

  it('turns down a prefix another snippet uses, whatever its case', () => {
    const other = snippet({ id: 'b', name: 'Other', prefix: 'PRE' })
    expect(snippetProblem(snippet(), [snippet(), other])).toBe('“Other” already uses the prefix pre.')
    expect(snippetProblem(snippet(), [snippet()])).toBeNull()
  })
})

describe('the export file', () => {
  it('round-trips without ids', () => {
    const file = snippetExportFile([snippet({ description: 'about' })], new Date('2026-01-02T00:00:00Z'))
    expect(file).toEqual({
      kind: 'tableview/snippets',
      version: 1,
      exportedAt: '2026-01-02T00:00:00.000Z',
      snippets: [{ name: 'Name', prefix: 'pre', body: 'SELECT 1;', description: 'about' }]
    })
    expect(parseSnippetFile(JSON.stringify(file))).toEqual(file.snippets)
  })

  it('refuses what is not one, and skips entries it cannot read', () => {
    expect(() => parseSnippetFile('nope')).toThrow(/not JSON/)
    expect(() => parseSnippetFile('{"kind":"tableview/connections","connections":[]}')).toThrow(
      /not a TableView snippets export/
    )
    expect(() => parseSnippetFile('{"kind":"tableview/snippets","version":9,"snippets":[]}')).toThrow(
      /newer TableView/
    )
    expect(
      parseSnippetFile(
        '{"kind":"tableview/snippets","version":1,"snippets":[{"name":"x"},{"name":"y","prefix":"y","body":"1"}]}'
      )
    ).toEqual([{ name: 'y', prefix: 'y', body: '1' }])
  })
})

describe('mergeSnippets', () => {
  let n = 0
  const newId = (): string => `new-${(n += 1)}`

  it('replaces by prefix, keeping the id, and adds the rest', () => {
    const current = [snippet({ id: 'keep', prefix: 'tran' })]
    const { snippets, summary } = mergeSnippets(
      current,
      [
        { name: 'Theirs', prefix: 'TRAN', body: 'x' },
        { name: 'New', prefix: 'audit', body: 'y' }
      ],
      newId
    )
    expect(summary).toEqual({ added: ['audit'], replaced: ['TRAN'] })
    expect(snippets[0]).toEqual({ id: 'keep', name: 'Theirs', prefix: 'TRAN', body: 'x' })
    expect(snippets[1]).toMatchObject({ name: 'New', prefix: 'audit' })
  })

  it('leaves out snippets that could not be saved, and a prefix the file repeats', () => {
    const { snippets, summary } = mergeSnippets(
      [],
      [
        { name: '', prefix: 'a', body: 'x' },
        { name: 'B', prefix: 'b c', body: 'x' },
        { name: 'D', prefix: 'd', body: 'first' },
        { name: 'D again', prefix: 'd', body: 'second' }
      ],
      newId
    )
    expect(summary).toEqual({ added: ['d'], replaced: [] })
    expect(snippets.map((s) => s.body)).toEqual(['first'])
  })
})
