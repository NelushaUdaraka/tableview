/**
 * The window's one icon set.
 *
 * Drawn on a 24px grid with round caps and joins, in the manner of Lucide,
 * and stroked so they sit at the weight of the text beside them. Glyphs typed
 * into templates were at the mercy of whichever font a platform fell back to —
 * a different size, weight and baseline on every machine; these render the
 * same everywhere and take their colour from the text they sit in.
 *
 * Each icon is a list of path data. A shape that should be solid rather than
 * outlined — a dot, the run triangle — says so.
 */

export type IconShape = string | { d: string; fill: true }

const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`

const rect = (x: number, y: number, w: number, h: number, r: number): string =>
  `M${x + r} ${y}h${w - r * 2}a${r} ${r} 0 0 1 ${r} ${r}v${h - r * 2}a${r} ${r} 0 0 1 ${-r} ${r}` +
  `h${-(w - r * 2)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - r * 2)}a${r} ${r} 0 0 1 ${r} ${-r}z`

const dot = (cx: number, cy: number, r = 1.2): IconShape => ({ d: circle(cx, cy, r), fill: true })

const GEAR =
  'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'

const EYE =
  'M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0'

const TRAY = 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'

export const ICONS = {
  // --- actions ---------------------------------------------------------------
  plus: ['M12 5v14', 'M5 12h14'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  search: [circle(11, 11, 7.5), 'm20.5 20.5-4.2-4.2'],
  refresh: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  more: [dot(12, 5.5, 1.5), dot(12, 12, 1.5), dot(12, 18.5, 1.5)],
  play: [{ d: 'M7 4.6v14.8a1 1 0 0 0 1.53.85l11.6-7.4a1 1 0 0 0 0-1.7L8.53 3.75A1 1 0 0 0 7 4.6z', fill: true }],
  stop: [{ d: rect(6, 6, 12, 12, 2), fill: true }],
  filter: ['M22 3H2l8 9.46V19l4 2v-8.54z'],
  'filter-x': ['M13 3H2l8 9.46V19l4 2v-8.54l.9-1.06', 'm22 3-5 5', 'm17 3 5 5'],
  download: [TRAY, 'm7 10 5 5 5-5', 'M12 15V3'],
  upload: [TRAY, 'm17 8-5-5-5 5', 'M12 3v12'],
  copy: [rect(8, 8, 14, 14, 2), 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  'clipboard-paste': [
    rect(8, 2, 8, 4, 1),
    'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.79-1.11',
    'M16 4h2a2 2 0 0 1 2 2v1.34',
    'M11 14h10',
    'm17 10 4 4-4 4'
  ],
  trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
  power: ['M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.77.04'],
  'align-left': ['M21 6H3', 'M15 12H3', 'M17 18H3'],
  'folder-open': [
    'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'
  ],
  save: [
    'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7',
    'M7 3v4a1 1 0 0 0 1 1h7'
  ],

  // --- direction ---------------------------------------------------------------
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
  'arrow-left': ['M19 12H5', 'm12 19-7-7 7-7'],
  'corner-down-left': ['M20 4v7a4 4 0 0 1-4 4H4', 'm9 10-5 5 5 5'],

  // --- objects -----------------------------------------------------------------
  activity: ['M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2'],
  table: [rect(3, 3, 18, 18, 2.5), 'M3 9h18', 'M3 15h18', 'M9 9v12'],
  columns: [rect(3, 3, 18, 18, 2.5), 'M9 3v18', 'M15 3v18'],
  view: [EYE, circle(12, 12, 3)],
  function: [rect(3, 3, 18, 18, 2.5), 'M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3', 'M9 11.2h5.7'],
  procedure: [rect(3, 3, 18, 18, 2.5), 'M10 17V7h3.25a2.75 2.75 0 0 1 0 5.5H10'],
  trigger: ['M13 2 4 13.5h7.5L10.5 22 20 10.5h-7.5z'],
  terminal: [rect(3, 3, 18, 18, 2.5), 'm7.5 9.5 2.5 2.5-2.5 2.5', 'M12.5 14.5h4'],
  database: ['M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0', 'M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0'],
  key: ['m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4', 'm21 2-9.6 9.6', circle(7.5, 15.5, 5.5)],
  link: [
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'
  ],
  list: ['M9 6h12', 'M9 12h12', 'M9 18h12', dot(4, 6), dot(4, 12), dot(4, 18)],
  star: [
    {
      d: 'M12 2.8l2.84 5.76 6.36.92-4.6 4.49 1.09 6.33L12 17.31l-5.69 2.99 1.09-6.33-4.6-4.49 6.36-.92z',
      fill: true
    }
  ],

  // --- state and chrome ----------------------------------------------------------
  eye: [EYE, circle(12, 12, 3)],
  'eye-off': [
    'M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49',
    'M14.08 14.16a3 3 0 0 1-4.24-4.24',
    'M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14',
    'm2 2 20 20'
  ],
  'panel-right': [rect(3, 3, 18, 18, 2.5), 'M15 3v18'],
  lock: [rect(3, 11, 18, 11, 2), 'M7 11V7a5 5 0 0 1 10 0v4'],
  'lock-open': [rect(3, 11, 18, 11, 2), 'M7 11V7a5 5 0 0 1 9.9-1'],
  'shield-check': [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'm9 12 2 2 4-4'
  ],
  clock: [circle(12, 12, 9.5), 'M12 7v5l3 2'],
  sun: [
    circle(12, 12, 4),
    'M12 2v2',
    'M12 20v2',
    'm4.93 4.93 1.41 1.41',
    'm17.66 17.66 1.41 1.41',
    'M2 12h2',
    'M20 12h2',
    'm6.34 17.66-1.41 1.41',
    'm19.07 4.93-1.41 1.41'
  ],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  monitor: [rect(2, 3, 20, 14, 2.5), 'M8 21h8', 'M12 17v4'],
  settings: [GEAR, circle(12, 12, 3)],
  keyboard: [
    rect(2, 5, 20, 14, 2.5),
    'M6.5 9h.01',
    'M10.5 9h.01',
    'M14.5 9h.01',
    'M18 9h.01',
    'M8.5 12.5h.01',
    'M12.5 12.5h.01',
    'M16 12.5h.01',
    'M7.5 16h9'
  ],
  'circle-check': [circle(12, 12, 9.5), 'm8.5 12 2.5 2.5 5-5'],
  'circle-x': [circle(12, 12, 9.5), 'm15 9-6 6', 'm9 9 6 6'],
  info: [circle(12, 12, 9.5), 'M12 16v-4.5', 'M12 8h.01'],
  'triangle-alert': [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01'
  ]
} satisfies Record<string, IconShape[]>

export type IconName = keyof typeof ICONS
