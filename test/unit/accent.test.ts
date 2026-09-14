/**
 * The accent a connection paints its window with.
 *
 * One stored hex, and every shade the design needs derived from it — so the
 * check here is not that the numbers are particular numbers, but that what
 * comes out is usable: readable text on the fill, keywords that can be read on
 * the editor's ground either way up, and a pale colour saved back when this was
 * only a stripe in a list still producing something legible.
 */
import { describe, expect, it } from 'vitest'
import {
  ACCENT_SWATCHES,
  accentVariables,
  contrastRatio,
  normalizeHex,
  parseHex,
  textOn
} from '../../src/shared/accent'

/** The grounds the accent has to work against, from the stylesheet. */
const GROUND = {
  appDark: parseHex('#1a1918')!,
  appLight: parseHex('#eae7e7')!,
  surfaceDark: parseHex('#201e1d')!,
  surfaceLight: parseHex('#f3f2f2')!
}

describe('parseHex', () => {
  it('reads the forms a colour is written in', () => {
    expect(parseHex('#1971c2')).toEqual({ r: 0x19, g: 0x71, b: 0xc2 })
    expect(parseHex('1971C2')).toEqual({ r: 0x19, g: 0x71, b: 0xc2 })
    // Shorthand expands the way CSS expands it.
    expect(parseHex('#f0a')).toEqual({ r: 0xff, g: 0x00, b: 0xaa })
  })

  it('refuses anything that is not one', () => {
    for (const value of ['', '  ', 'red', '#12345', '#gggggg', undefined, null]) {
      expect(parseHex(value)).toBeNull()
    }
  })

  it('normalises to one spelling', () => {
    expect(normalizeHex('1971C2')).toBe('#1971c2')
    expect(normalizeHex('#f0a')).toBe('#ff00aa')
    expect(normalizeHex('nonsense')).toBeNull()
  })
})

describe('accentVariables', () => {
  it('says nothing for a connection with no colour of its own', () => {
    // Which is how the stylesheet keeps the app's own red, rather than a copy
    // of it that could drift.
    expect(accentVariables('', 'dark')).toBeNull()
    expect(accentVariables(undefined, 'light')).toBeNull()
    expect(accentVariables('not a colour', 'dark')).toBeNull()
  })

  it('derives the whole set from the one colour', () => {
    const dark = accentVariables('#1971c2', 'dark')!
    expect(dark['--accent']).toBe('#1971c2')
    // A hover that is the same colour would read as a dead button.
    expect(dark['--accent-hover']).not.toBe(dark['--accent'])
    expect(Object.keys(dark).sort()).toEqual([
      '--accent',
      '--accent-bright',
      '--accent-hover',
      '--accent-text'
    ])
  })

  it('turns the keyword colour the right way up for each theme', () => {
    const colour = parseHex('#1971c2')!
    const dark = parseHex(accentVariables('#1971c2', 'dark')!['--accent-bright'])!
    const light = parseHex(accentVariables('#1971c2', 'light')!['--accent-bright'])!

    // Lighter than the accent on the dark theme, darker on the light one.
    expect(contrastRatio(dark, GROUND.surfaceDark)).toBeGreaterThan(
      contrastRatio(colour, GROUND.surfaceDark)
    )
    expect(contrastRatio(light, GROUND.surfaceLight)).toBeGreaterThan(
      contrastRatio(colour, GROUND.surfaceLight)
    )
  })

  it('keeps text on the accent readable, whatever the colour', () => {
    // The pale colours the picker used to offer are still on saved connections.
    for (const colour of ['#f0a91d', '#58a6ff', '#3fb950', '#bc8cff', '#ff7b72']) {
      const variables = accentVariables(colour, 'dark')!
      const ratio = contrastRatio(parseHex(colour)!, parseHex(variables['--accent-text'])!)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the house white on a colour dark enough to carry it', () => {
    expect(textOn(parseHex('#1971c2')!)).toBe('#ffffff')
    expect(textOn(parseHex('#f0a91d')!)).not.toBe('#ffffff')
  })
})

/**
 * The swatches are the ones offered in the form, so they answer for the design
 * rather than for the maths: the accent is used as text as well as as a fill.
 */
describe('the offered swatches', () => {
  const colours = ACCENT_SWATCHES.filter((swatch) => swatch.hex)

  it('offers the app’s own accent as the default, with no colour attached', () => {
    expect(ACCENT_SWATCHES[0].hex).toBe('')
    expect(colours.length).toBeGreaterThanOrEqual(6)
  })

  it('reads as text on both grounds', () => {
    for (const { hex, label } of colours) {
      const colour = parseHex(hex)!
      expect(
        [contrastRatio(colour, GROUND.appDark), contrastRatio(colour, GROUND.appLight)],
        `${label} (${hex})`
      ).toSatisfy((ratios: number[]) => ratios.every((ratio) => ratio >= 3))
    }
  })

  it('carries readable keywords on both grounds', () => {
    for (const { hex, label } of colours) {
      const dark = parseHex(accentVariables(hex, 'dark')!['--accent-bright'])!
      const light = parseHex(accentVariables(hex, 'light')!['--accent-bright'])!
      expect(contrastRatio(dark, GROUND.surfaceDark), `${label} on dark`).toBeGreaterThanOrEqual(
        4.5
      )
      expect(contrastRatio(light, GROUND.surfaceLight), `${label} on light`).toBeGreaterThanOrEqual(
        4.5
      )
    }
  })

  it('is distinct, so two connections cannot be told apart only by squinting', () => {
    expect(new Set(colours.map((swatch) => swatch.hex)).size).toBe(colours.length)
    expect(new Set(colours.map((swatch) => swatch.label)).size).toBe(colours.length)
  })
})
