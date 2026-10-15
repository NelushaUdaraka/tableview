/**
 * The dialogs open in the window, oldest first.
 *
 * A dialog can open over another — the read-only question over the connection
 * form, fresh credentials over a test — and Escape should close only the one on
 * top. Each dialog listens on the document, so each asks here whether it is
 * the top one before it acts; otherwise Escape on the question would also
 * close the form under it, edits and all.
 */
const open: symbol[] = []

export function openModal(): symbol {
  const token = Symbol('modal')
  open.push(token)
  return token
}

export function closeModal(token: symbol): void {
  const index = open.indexOf(token)
  if (index >= 0) open.splice(index, 1)
}

export function isTopModal(token: symbol): boolean {
  return open[open.length - 1] === token
}
