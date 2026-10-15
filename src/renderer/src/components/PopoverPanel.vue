<script setup lang="ts">
/**
 * A panel that drops from the button that opened it.
 *
 * Drawn here rather than left to the platform. A native `<select>` popup takes
 * its colours from the control it hangs off, and laid under a toolbar button
 * that control is invisible — the auto-refresh list came up white, its grey
 * text all but unreadable on the dark theme, and a few pixels off the button
 * it was opened from. This sits under its button with their right edges
 * flush (or left, for one at the start of a bar), in the overlay colours every
 * menu in the window uses, and is clamped to the window like the right-click
 * menu.
 *
 * It owns the parts every such panel needs the same: where it goes, closing on
 * a click elsewhere or on Escape, and the arrow keys stepping between the
 * entries marked `data-popover-item`. What it holds is the caller's.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** The button it hangs from, which also gets the focus back when it closes. */
    anchor: HTMLElement | null
    /** Which of the anchor's edges it lines up with. */
    align?: 'start' | 'end'
    /** A list of choices is a menu; a panel with a field in it is a dialog. */
    role?: 'menu' | 'dialog'
    label: string
  }>(),
  { align: 'end', role: 'menu' }
)

const emit = defineEmits<{ (event: 'close'): void }>()

const panel = ref<HTMLElement | null>(null)
const placed = ref<{ top: number; left: number; maxHeight: number } | null>(null)

/** Room left between the panel and the button, and between it and the window's edge. */
const GAP = 4
const MARGIN = 8

function place(): void {
  const anchor = props.anchor?.getBoundingClientRect()
  const own = panel.value?.getBoundingClientRect()
  if (!anchor || !own) return
  const left = props.align === 'end' ? anchor.right - own.width : anchor.left
  const top = anchor.bottom + GAP
  placed.value = {
    top,
    left: Math.max(MARGIN, Math.min(left, window.innerWidth - own.width - MARGIN)),
    // A long list scrolls inside the panel rather than running off the window.
    maxHeight: Math.max(120, window.innerHeight - top - MARGIN)
  }
}

/** Measured before it is shown, so it never draws for a frame in the wrong place. */
const style = computed(() =>
  placed.value
    ? {
        top: `${placed.value.top}px`,
        left: `${placed.value.left}px`,
        maxHeight: `${placed.value.maxHeight}px`
      }
    : { top: '0px', left: '0px', visibility: 'hidden' as const }
)

function items(): HTMLElement[] {
  return [...(panel.value?.querySelectorAll<HTMLElement>('[data-popover-item]') ?? [])].filter(
    (element) => !(element as HTMLButtonElement).disabled
  )
}

/** Where the focus starts: the entry marked for it, or the first one. */
function focusFirst(): void {
  const marked = panel.value?.querySelector<HTMLElement>('[data-popover-autofocus]')
  ;(marked ?? items()[0])?.focus()
}

function close(): void {
  emit('close')
}

function onDocumentMouseDown(event: MouseEvent): void {
  const target = event.target as Node | null
  if (!target || panel.value?.contains(target)) return
  // The button toggles the panel itself; closing here as well would have it
  // close and then open again on the same click.
  if (props.anchor?.contains(target)) return
  close()
}

/** Escape with the focus somewhere else in the window still closes it. */
function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (panel.value?.contains(event.target as Node)) return
  close()
}

function isTextField(element: EventTarget | null): boolean {
  return element instanceof HTMLInputElement && element.type !== 'checkbox'
}

/**
 * The keys a list answers to.
 *
 * Handled on the panel and kept there, so the grid underneath — which listens
 * for the same keys — does not move its selection as well.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  const list = items()
  if (list.length === 0) return
  const current = list.indexOf(document.activeElement as HTMLElement)

  let next: number | null = null
  if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % list.length
  else if (event.key === 'ArrowUp') next = current <= 0 ? list.length - 1 : current - 1
  // In a text field Home and End belong to the caret.
  else if (event.key === 'Home' && !isTextField(event.target)) next = 0
  else if (event.key === 'End' && !isTextField(event.target)) next = list.length - 1
  if (next === null) return

  event.preventDefault()
  event.stopPropagation()
  list[next].focus()
}

/**
 * Leaving by Tab takes the panel away, as it does a menu. A click elsewhere is
 * the mousedown's to deal with, and the anchor's own click toggles.
 */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (!next || panel.value?.contains(next) || props.anchor?.contains(next)) return
  close()
}

onMounted(async () => {
  place()
  await nextTick()
  focusFirst()
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  document.addEventListener('keydown', onDocumentKeyDown)
  window.addEventListener('resize', place)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  document.removeEventListener('keydown', onDocumentKeyDown)
  window.removeEventListener('resize', place)
  // Focus inside a panel that is going would fall to the page; the button it
  // came from is where the reader was.
  if (panel.value?.contains(document.activeElement)) props.anchor?.focus()
})
</script>

<template>
  <div
    ref="panel"
    class="popover"
    :style="style"
    :role="role"
    :aria-label="label"
    @keydown="onKeyDown"
    @focusout="onFocusOut"
  >
    <slot />
  </div>
</template>

<style scoped>
/* The overlay the right-click menu is drawn in: a step up from everything
   under it, a hairline edge and a soft shadow. */
.popover {
  position: fixed;
  display: flex;
  flex-direction: column;
  min-width: 180px;
  padding: 4px;
  border: 1px solid var(--border-overlay);
  border-radius: var(--radius);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-menu);
  color: var(--text-primary);
  z-index: 300;
  overflow: auto;
  animation: fade-in var(--duration-fast) var(--ease);
}
</style>
