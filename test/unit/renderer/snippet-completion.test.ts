/**
 * Where the editor offers snippets: a word in code, not a qualified name,
 * a variable, a comment or a string.
 */
import { describe, expect, it } from 'vitest'
import { snippetFrom } from '../../../src/renderer/src/lib/snippetCompletion'

function at(text: string, explicit = false): number | null {
  const pos = text.indexOf('|')
  return snippetFrom(text.replace('|', ''), pos, explicit)
}

describe('snippetFrom', () => {
  it('starts at the word being typed', () => {
    expect(at('tr|')).toBe(0)
    expect(at('SELECT 1;\n  tr|')).toBe(12)
  })

  it('offers nothing for an empty word unless asked', () => {
    expect(at('SELECT |')).toBeNull()
    expect(at('SELECT |', true)).toBe(7)
  })

  it('offers nothing after a dot, for variables and temp tables, or outside code', () => {
    expect(at('SELECT c.tr|')).toBeNull()
    expect(at('SELECT @tr|')).toBeNull()
    expect(at('SELECT * FROM #tr|')).toBeNull()
    expect(at("SELECT 'tr|")).toBeNull()
    expect(at('-- tr|')).toBeNull()
  })
})
