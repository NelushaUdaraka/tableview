/**
 * Which dialog Escape belongs to.
 *
 * A dialog can open over another — the read-only question over the connection
 * form — and every dialog listens on the document, so each asks whether it is
 * the one on top before it closes. Without that, Escape on the question would
 * also close the form under it, edits and all.
 */
import { describe, expect, it } from 'vitest'
import { closeModal, isTopModal, openModal } from '../../../src/renderer/src/lib/modalStack'

describe('the dialog on top', () => {
  it('is the one opened last', () => {
    const form = openModal()
    const question = openModal()
    expect(isTopModal(question)).toBe(true)
    expect(isTopModal(form)).toBe(false)
    closeModal(question)
    closeModal(form)
  })

  it('is the one underneath again once the top one closes', () => {
    const form = openModal()
    const question = openModal()
    closeModal(question)
    expect(isTopModal(form)).toBe(true)
    closeModal(form)
  })

  it('stays on top when one underneath closes first', () => {
    const form = openModal()
    const question = openModal()
    closeModal(form)
    expect(isTopModal(question)).toBe(true)
    closeModal(question)
    expect(isTopModal(question)).toBe(false)
  })
})
