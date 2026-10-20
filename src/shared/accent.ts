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
 * as well as as a fill. Empty is the app's indigo — the connection that has not
 * asked for anything in particular. Red is offered rather than assumed: it is
 * the colour people reach for to mark production, which is exactly why it
 * should not be every window's colour.
 */
export const ACCENT_SWATCHES: AccentSwatch[] = [
  { hex: '', label: 'Default (indigo)' },
  { hex: '#e03131', label: 'Red' },
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
 * The app's own indigo carries 5.2:1 with white, and several of the swatches
 * sit near 4:1; the bar is what separates "this is the house style" from
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

/**
 * A colour's chroma and hue angle in OKLCH, where a hue reads the same however
 * light or dark the colour is.
 */
function chromaAndHue({ r, g, b }: Rgb): { chroma: number; hue: number } {
  const linear = (value: number): number => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const green = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const blue = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return {
    chroma: Math.hypot(green, blue),
    hue: ((Math.atan2(blue, green) * 180) / Math.PI + 360) % 360
  }
}

/** Below this chroma a colour has no hue worth matching: a grey, black or white. */
const NEUTRAL_CHROMA = 0.04

/**
 * The offered swatch a colour from elsewhere looks most like.
 *
 * A colour brought in with a connection — TablePlus's status colour, say — was
 * never checked against these grounds, so it lands on a swatch and takes that
 * swatch's guarantees with it. Never the default: a connection that arrives
 * with a colour of its own should not arrive looking like one without.
 *
 * Matched by hue, not by distance in RGB, which sent a bright red to Orange, a
 * dark red to Amber and black to Green — and red is the colour people give
 * production. A colour with no hue to speak of goes to the neutral swatch.
 */
export function nearestSwatch(value: string | undefined | null): AccentSwatch | null {
  const colour = parseHex(value)
  if (!colour) return null
  const { chroma, hue } = chromaAndHue(colour)
  const offered = ACCENT_SWATCHES.flatMap((swatch) => {
    const rgb = parseHex(swatch.hex)
    return rgb ? [{ swatch, ...chromaAndHue(rgb) }] : []
  })
  if (chroma < NEUTRAL_CHROMA) {
    return offered.reduce((best, next) => (next.chroma < best.chroma ? next : best)).swatch
  }
  const apart = (angle: number): number => {
    const turn = Math.abs(angle - hue) % 360
    return Math.min(turn, 360 - turn)
  }
  return offered
    .filter((entry) => entry.chroma >= NEUTRAL_CHROMA)
    .reduce((best, next) => (apart(next.hue) < apart(best.hue) ? next : best)).swatch
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
 * relationship the app's own indigo already has with itself.
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
