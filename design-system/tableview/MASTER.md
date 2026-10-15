# Design System Master File

> **LOGIC:** When building a specific screen, first check `design-system/tableview/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.
>
> **Recorded, not generated.** This file describes the design system the app already ships. The
> code source of truth is `src/renderer/src/styles/index.css`, which defines every token below for
> both themes. If the two ever disagree, the stylesheet wins — fix this file. Do not regenerate it
> with `search.py --design-system --persist --force`: the generated defaults (green accent, IBM Plex
> from Google Fonts, landing-page sections, mobile breakpoints) do not fit this app.

---

**Project:** TableView
**Recorded:** 2026-10-15
**Category:** Developer Tool / IDE — a desktop (Electron) SQL Server client
**Stack:** Vue 3 single-file components with scoped CSS, over CSS custom properties. No Tailwind.
**Design Dials:** Variance 3/10 (Centered / Minimal) | Motion 3/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

Grounds step forward in lightness: chrome → content → raised → overlay.

| Role | Dark | Light | CSS Variable |
|------|------|-------|--------------|
| Chrome (title bar, sidebar, tab strip, status bar, grid header) | `#111317` | `#f4f5f7` | `--bg-app` |
| Content (editor, grid, toolbars) | `#16181d` | `#ffffff` | `--bg-surface` |
| Raised block | `#1d2026` | `#eef0f3` | `--bg-raised` |
| Overlay (menus, dialogs, toasts) | `#1c1f25` | `#ffffff` | `--bg-overlay` |
| Input | `#121418` | `#ffffff` | `--bg-input` |
| Control (secondary button) | `#1f2228` | `#ffffff` | `--bg-control` |
| Text | `#e6e8eb` | `#16181d` | `--text-primary` |
| Secondary text | `#a9aeb7` | `#4b5260` | `--text-secondary` |
| Muted text | `#858b96` | `#646c79` | `--text-muted` |
| Hint text (counts, line numbers only) | `#686e79` | `#8a919d` | `--text-dim` |
| Data-row border | `#212429` | `#eceef2` | `--border` |
| Chrome divider | `#262a30` | `#e4e7eb` | `--border-subtle` |
| Control border | `#343840` | `#d3d8de` | `--border-strong` |
| Accent / CTA (default) | `#3e63dd` | `#3e63dd` | `--accent` |
| On accent | `#ffffff` | `#ffffff` | `--accent-text` |
| Accent as text | 60% accent + white | 86% accent + black | `--accent-fg` |
| Accent wash | 17% accent | 11% accent | `--accent-soft` |
| Focus ring | 42% accent | 30% accent | `--accent-ring` |
| Success | `#3fb950` | `#1a7f37` | `--success` |
| Warning / staged | `#d29922` | `#9a6700` | `--warning` |
| Danger | `#f85149` | `#cf222e` | `--danger` |
| Primary key | `#e3b341` | `#9a6700` | `--key` |

**Color Notes:**

- One accent, spent only on what acts, what is selected and what has focus.
- **A connection's colour replaces the accent at runtime.** `lib/accent.ts` overrides `--accent`, `--accent-hover`, `--accent-bright` and `--accent-text` on the document root. Components therefore never write the accent's hex: use the tokens, and `color-mix()` from them for washes.
- The accent is never red. Red is the danger colour, and the colour people give their production connections (it is one of the swatches in `shared/accent.ts`).
- Primary, secondary and muted text clear 4.5:1 on every ground in both themes. `--text-dim` is only for hints beside something stronger.

**Syntax (SQL editor, JSON tree):**

| Token | Dark | Light |
|-------|------|-------|
| `--syntax-keyword` | `--accent-bright` (`#a8b9f0`) | `--accent-bright` (`#2d479f`) |
| `--syntax-string` | `#e2a77d` | `#a3501a` |
| `--syntax-number` | `#7fd3b3` | `#0f7b53` |
| `--syntax-function` | `#cdb2ff` | `#6f42c1` |
| `--syntax-type` | `#74c7da` | `#0b7285` |
| `--syntax-comment` | `#7d838e` | `#6e7681` |

### Typography

- **Interface font:** Inter (variable, latin subset), vendored in `src/renderer/src/assets/fonts/`
- **Data and code font:** JetBrains Mono (400/500/700), vendored; users can override `--font-mono` in Settings
- **Never** load fonts or any other asset remotely: the renderer's CSP is `font-src 'self' data:` and `img-src 'self' data:`.
- **Mono is for anything that is data or an identifier:** grid cells, column names, SQL, types, endpoints.
- **Scale:** 10–11px small caps, 12px secondary text, 13px body (`--font-size`), 14px emphasis, 16px dialog titles, 22px page titles.
- **Weights:** 400 body, 500 labels and buttons, 600 headings and active states, 700 key badges.
- **Case:** sentence-case labels. Uppercase (`.caps`: 11px, 600, 0.06em) only for small section headings. Identifiers keep their own case and are never uppercased.

### Spacing Variables

*Density: 8/10 — Dense / Dashboard.* Spacing sits on a 4px grid (2, 4, 6, 8, 10, 12, 16, 20, 24, 32). Sizes are tokens:

| Token | Value | Usage |
|-------|-------|-------|
| `--h-control` / `-sm` / `-lg` | `28px` / `24px` / `32px` | Buttons, segmented controls |
| `--h-field` | `32px` | Inputs and selects |
| `--row-height` | `30px` | Grid rows |
| `--h-titlebar` | `40px` | Title bar |
| `--h-tabstrip` | `38px` | Tab strip, results bar |
| `--h-commandbar` | `44px` | View toolbars |
| `--h-gridheader` | `36px` | Grid header, row panel header, table footer |
| `--h-statusbar` | `28px` | Status bar |
| `--radius-xs` / `-sm` / (base) / `-lg` | `4px` / `6px` / `8px` / `12px` | Badges / controls / menus and panels / dialogs |

Count pills are fully rounded (`999px`).

### Shadow Depths

| Level | Dark value | Usage |
|-------|------------|-------|
| `--shadow-xs` | `0 1px 0 rgba(0,0,0,0.28)` | A control's lip |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.4), 0 1px 1px rgba(0,0,0,0.2)` | Primary button, segmented thumb |
| `--shadow-menu` | `0 14px 32px -8px rgba(0,0,0,0.6), 0 4px 12px -4px rgba(0,0,0,0.45)` | Menus, toasts, popovers |
| `--shadow` | `0 32px 80px -20px rgba(0,0,0,0.75), 0 12px 28px -12px rgba(0,0,0,0.55)` | Dialogs |

The light theme defines softer values for each level.

---

## Component Specs

Use the shared classes in `index.css` and the shared components rather than restyling per screen.

- **Buttons:** `.btn` (raised secondary), `.btn--primary` (one per view), `.btn--muted` / `.btn--ghost` (quiet), `.btn--danger`, `.btn--armed` (live state: a filter set, a panel open). Sizes `.btn--sm` / `.btn--lg`; `.btn--icon` for square icon buttons. Labels are centred; an icon goes before the label.
- **Inputs:** `.input`, `.select`, `.textarea`. Focus is an accent border plus a 3px `--accent-ring`. Add `.mono` for code-like values.
- **Fields:** `.field` with a `.field__label` (12px, 500, sentence case) and an optional `.field__hint`.
- **Segmented controls:** `.seg` / `.seg__opt` / `.seg__opt--on` (a lifted thumb, never an accent fill), with `.seg__count` for counts.
- **Badges:** `.badge`, `.badge--accent`, `.badge--pk` (gold), `.badge--fk` (accent).
- **Checkbox:** `.checkbox` wrapping a native input.
- **Switch:** `.switch` (on: `.switch--on`), drawn inside the button that flips it — `role="switch"`, `aria-checked`, and a visible label beside it — for a setting that holds the moment it is flipped, such as the status bar's *Read-only*. A field that waits for *Save* stays a `.checkbox`.
- **Empty states:** `.empty-state` containing `.empty-state__icon`, `.empty-state__title`, a `<p>` and at most one primary button.
- **Overlays:** `BaseModal` (kicker, title, subtitle, footer slot), `ContextMenu`, and the toasts store (`info`, `success`, `error`).
- **Drop-downs from a toolbar button:** `PopoverPanel` hangs under the button that opened it (right edges flush by default), in the overlay ground, and closes on Escape or a click elsewhere, giving the focus back. `ChoiceMenu` is one choice out of a few in it (radio items, the current one ticked); `ColumnPicker` is a checklist in it. A native `<select>` hidden under a styled button draws its list in the hidden control's colours — give that control `--bg-input` and `--text-primary`, or use `ChoiceMenu`.
- **Icons:** `lib/icons.ts`, drawn by `components/AppIcon.vue` (24px grid, Lucide-style strokes, decorative by default). Icon-only buttons need an `aria-label`. Never type glyphs such as ✕ ⋮ ▾ ⟳ ⌕; add an icon to `lib/icons.ts` instead.
- **Brand:** `components/BrandMark.vue`, the app icon's graphite T-grid: a table whose header row and middle
  column make a T. `build/icon.svg` is its source, and `build/icon.png` is rendered from that. It uses brand
  colours, not the accent.

---

## Style Guidelines

**Style:** Minimalism & Swiss Style, dark-first, with a commercial developer-tool finish: layered grounds, hairline borders, soft radii and one accent.

**Keywords:** Calm, layered, dense, precise, keyboard-first

**Best For:** Long working sessions over data. Nothing decorative competes with the grid or the editor.

**Key Effects:** 110ms state transitions (`--transition`); a hover never shifts layout; selection is an accent wash; staged edits are an accent edge or underline, never a fill over the value.

### Page Pattern

**Pattern Name:** Desktop workbench (not a landing page)

- **Frame:** title bar, sidebar, tab strip and status bar on `--bg-app`, around a content canvas on `--bg-surface`.
- **A view:** a 44px command bar, then the content, then an optional 36px footer bar.
- **Connection screen:** a centred launcher, max 1120px wide, with a card list and one primary action ("New connection").

---

## Motion

Tokens: `--ease` (state), `--ease-out` (arrivals), `--duration-fast` 110ms, `--duration` 160ms, `--duration-slow` 220ms. Keyframes: `fade-in` (menus), `rise-in` (toasts), `dialog-in` (dialogs: 10px and 0.98 scale).

- ✅ Animate opacity and transform only.
- ✅ Under `prefers-reduced-motion: reduce` everything stands still, except spinners, which keep turning.
- ❌ No GSAP, scroll-driven or decorative animation.

---

## Anti-Patterns (Do NOT Use)

- ❌ **Raw hex colours in components.** Use the tokens; connection colours depend on it.
- ❌ **Red as the accent, or the accent on destructive actions.** Use `.btn--danger`.
- ❌ **Remote fonts or assets.** The CSP blocks them; vendor them instead.
- ❌ **Typed Unicode glyphs as icons.**
- ❌ **The previous "Modernist" look:** 2px rules, zero radius, mono micro-caps labels.
- ❌ **Uppercased identifiers.** Column and table names keep their case.
- ❌ **More than one primary button in a view.**
- ❌ **Animating width, height, top or left**, or motion without a reduced-motion fallback.

---

## Pre-Delivery Checklist

Before delivering any UI change, verify:

- [ ] Both themes checked (`data-theme` dark and light), including with a connection colour applied
- [ ] Tokens only: no new hex values in components
- [ ] Icons come from `lib/icons.ts`; icon-only buttons have an `aria-label`
- [ ] Keyboard focus is visible on every new control
- [ ] Body text is `--text-muted` or stronger (≥ 4.5:1)
- [ ] `prefers-reduced-motion` respected
- [ ] Checked at desktop window sizes (≥ 1024px wide); the app has no mobile layout
- [ ] Class names and button text that `test/e2e/*.mjs` reads are kept, or the suites updated with them
