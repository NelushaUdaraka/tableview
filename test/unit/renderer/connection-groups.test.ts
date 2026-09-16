/**
 * Filing the list under headings.
 *
 * A group is a name a connection carries rather than a record of its own, so
 * what is worth pinning down is what that implies: no empty groups, no second
 * group because someone typed the same name in lower case, and headings that
 * stay put while the rows under them are re-sorted.
 */
import { describe, expect, it } from 'vitest'
import {
  UNGROUPED_LABEL,
  groupConnections,
  groupNameOf,
  groupNames,
  hasGroups
} from '../../../src/renderer/src/lib/connectionGroups'
import type { SavedConnection } from '../../../src/shared/types'

const connection = (name: string, group?: string): SavedConnection =>
  ({ id: name, name, group, host: 'db', port: 1433 }) as SavedConnection

const shape = (connections: SavedConnection[]): [string, string[]][] =>
  groupConnections(connections).map((group) => [
    group.label,
    group.connections.map((entry) => entry.name)
  ])

describe('a connection’s group', () => {
  it('is what it says, without the stray spaces', () => {
    expect(groupNameOf(connection('a', '  Production  '))).toBe('Production')
  })

  it('is nothing when it is blank', () => {
    expect(groupNameOf(connection('a'))).toBe('')
    expect(groupNameOf(connection('a', '   '))).toBe('')
  })
})

describe('the groups in use', () => {
  it('are whatever the connections say they are, in order', () => {
    expect(
      groupNames([
        connection('a', 'Staging'),
        connection('b', 'Production'),
        connection('c'),
        connection('d', 'Production')
      ])
    ).toEqual(['Production', 'Staging'])
  })

  it('treat one name in two cases as one group', () => {
    // Typing "prod" under a heading that says "Prod" means that heading.
    expect(groupNames([connection('a', 'Prod'), connection('b', 'prod')])).toEqual(['Prod'])
  })

  it('are none at all when nothing has been filed', () => {
    expect(groupNames([connection('a'), connection('b')])).toEqual([])
    expect(hasGroups([connection('a')])).toBe(false)
    expect(hasGroups([connection('a'), connection('b', 'Prod')])).toBe(true)
  })
})

describe('breaking the list into its groups', () => {
  it('puts the named ones in order and the loose ones last', () => {
    expect(
      shape([
        connection('zeta', 'Staging'),
        connection('alpha'),
        connection('beta', 'Production'),
        connection('gamma', 'Staging')
      ])
    ).toEqual([
      ['Production', ['beta']],
      ['Staging', ['zeta', 'gamma']],
      [UNGROUPED_LABEL, ['alpha']]
    ])
  })

  it('keeps the order the rows arrived in, which is the sort the screen chose', () => {
    // The heading answers "where do I look"; the sort answers "which one" —
    // so grouping must not reorder what it is handed.
    const [, names] = shape([
      connection('third', 'Prod'),
      connection('first', 'Prod'),
      connection('second', 'Prod')
    ])[0]
    expect(names).toEqual(['third', 'first', 'second'])
  })

  it('gathers one group written two ways under the first spelling seen', () => {
    expect(shape([connection('a', 'Prod'), connection('b', 'prod')])).toEqual([
      ['Prod', ['a', 'b']]
    ])
  })

  it('draws no ungrouped heading when there is nothing under it', () => {
    expect(shape([connection('a', 'Prod')])).toEqual([['Prod', ['a']]])
  })

  it('is one unnamed group when nothing has been filed at all', () => {
    expect(shape([connection('a'), connection('b')])).toEqual([[UNGROUPED_LABEL, ['a', 'b']]])
  })
})
