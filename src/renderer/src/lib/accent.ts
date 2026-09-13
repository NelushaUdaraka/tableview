/**
 * Paints the window in the open connection's colour.
 *
 * The stylesheet holds the app's own accent and every shade the design takes
 * from it; a connection with a colour of its own overrides that set on the
 * document root, which is the one place every component reads it from. Clearing
 * the overrides hands the window back to the stylesheet rather than to a
 * remembered copy of it — so "no colour" cannot drift from the default.
 */
import { accentVariables } from '@shared/accent'

/** Only these are overridden; everything else derives from them in CSS. */
const ACCENT_PROPERTIES = ['--accent', '--accent-hover', '--accent-bright', '--accent-text']

export function applyAccent(colour: string | undefined | null, theme: 'dark' | 'light'): void {
  const root = document.documentElement
  const variables = accentVariables(colour, theme)

  if (!variables) {
    for (const property of ACCENT_PROPERTIES) root.style.removeProperty(property)
    return
  }
  for (const [property, value] of Object.entries(variables)) {
    root.style.setProperty(property, value)
  }
}
