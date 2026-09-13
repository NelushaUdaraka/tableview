/**
 * The accent a connection paints the window with.
 *
 * One colour runs through this UI — the button that acts, the tab that is
 * showing, the key badges, the focus ring — so colouring a connection colours
 * the window it is open in. Which is the point: two windows side by side,
 * production and staging, should not look the same.
 *
 * A saved colour is a single hex value, and everything else is derived from it
 * here rather than stored: a hover shade, the lighter or darker tint the SQL
 * keywords take, and whether text on top of it should be white or ink. That
 * keeps the stored connection to one field, lets a colour saved before any of
 * this existed still work, and means the derived set cannot fall out of step
 * with the colour it came from.
 */

/** A colour offered in the connection form. */
export interface AccentSwatch {
  hex: string
  label: string
}

/**
 * What the picker offers.
 *
 * Chosen to read as the app's own accent does: each one carries at least 3:1
 * against both the dark and the light ground, since the accent is used as text
 * as well as as a fill. Empty is the app's red — the connection that has not
 * asked for anything in particular.
 */
export const ACCENT_SWATCHES: AccentSwatch[] = [
  { hex: '', label: 'Default (red)' },
  { hex: '#d9480f', label: 'Orange' },
  { hex: '#b45309', label: 'Amber' },
  { hex: '#2b8a3e', label: 'Green' },
  { hex: '#099268', label: 'Teal' },
  { hex: '#1971c2', label: 'Blue' },
  { hex: '#7048e8', label: 'Violet' },
  { hex: '#d6336c', label: 'Pink' },
  { hex: '#5c7080', label: 'Slate' }
]

/** Text on top of an accent fill: the app's own white, or its darkest ink. */
const ON_ACCENT_LIGHT = '#ffffff'
const ON_ACCENT_DARK = '#16181d'

/**
 * How readable white has to be on a colour before it is used.
 *
 * The app's own red carries 4.2:1 with white, and several of the swatches sit
 * just under that; the bar is what separates "this is the house style" from
 * "nobody can read the button". Below it, ink wins — which is what rescues a
 * pale colour saved back when this was only a stripe in a list.
 */
const WHITE_MIN_CONTRAST = 3.2

interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * Reads `#rgb` or `#rrggbb`, with or without the hash.
 *
 * Anything else is not a colour this can derive from, and the caller falls
 * back to the app's own accent rather than painting the window with a guess.
 */
export function parseHex(value: string | undefined | null): Rgb | null {
  const text = (value ?? '').trim().replace(/^#/, '')
  const full = text.length === 3 ? text.replace(/./g, (c) => c + c) : text
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

/** The same colour, written the one way the rest of the app expects it. */
export function normalizeHex(value: string | undefined | null): string | null {
  const rgb = parseHex(value)
  return rgb ? toHex(rgb) : null
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

/** Straight sRGB mix, which is what `color-mix(in srgb, …)` does. */
function mix(colour: Rgb, towards: Rgb, amount: number): Rgb {
  const keep = 1 - amount
  return {
    r: colour.r * keep + towards.r * amount,
    g: colour.g * keep + towards.g * amount,
    b: colour.b * keep + towards.b * amount
  }
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 }
const WHITE: Rgb = { r: 255, g: 255, b: 255 }

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** Whichever of the app's two text colours can be read on this one. */
export function textOn(colour: Rgb): string {
  const white = parseHex(ON_ACCENT_LIGHT)!
  return contrastRatio(colour, white) >= WHITE_MIN_CONTRAST ? ON_ACCENT_LIGHT : ON_ACCENT_DARK
}

/**
 * The custom properties a connection's colour sets on the document.
 *
 * `--accent-bright` is the one that has to know the theme: it is the colour
 * the SQL keywords are painted in, over the editor's own ground, so it is a
 * light tint on the dark theme and a dark shade on the light one — the same
 * relationship the app's stock red already has with itself.
 *
 * Returns null for anything that is not a colour, which is how "this
 * connection has no colour of its own" reaches the caller.
 */
export function accentVariables(
  colour: string | undefined | null,
  theme: 'dark' | 'light'
): Record<string, string> | null {
  const rgb = parseHex(colour)
  if (!rgb) return null
  return {
    '--accent': toHex(rgb),
    '--accent-hover': toHex(mix(rgb, BLACK, 0.08)),
    '--accent-bright': toHex(theme === 'dark' ? mix(rgb, WHITE, 0.55) : mix(rgb, BLACK, 0.28)),
    '--accent-text': textOn(rgb)
  }
}
