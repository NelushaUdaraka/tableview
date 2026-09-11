/**
 * The tab currently being dragged, shared by every strip.
 *
 * `dragover` cannot read a drag's data — the browser withholds it until the
 * drop — so a strip being dragged *onto* has no way to ask the event what is
 * coming. This module is where the two agree instead; module scope rather than
 * component scope because each strip is its own component instance, and there
 * is only ever one drag at a time.
 */
export interface TabDrag {
  tabId: string
  paneId: string
}

let current: TabDrag | null = null
/** Whether the drag ended on a strip, which is what makes it not a detach. */
let landedOnStrip = false

export function beginTabDrag(drag: TabDrag): void {
  current = drag
  landedOnStrip = false
}

export function draggedTab(): TabDrag | null {
  return current
}

export function markTabDropped(): void {
  landedOnStrip = true
}

/** Ends the drag, reporting whether it was let go somewhere no strip claimed. */
export function endTabDrag(): { drag: TabDrag | null; landed: boolean } {
  const result = { drag: current, landed: landedOnStrip }
  current = null
  landedOnStrip = false
  return result
}
