/**
 * The proportional bar behind every breakdown row.
 *
 * Eleven sites carried `background: var(--bar)` as an inline style beside the
 * width they actually compute: the ten multi-metric panels on the dashboard,
 * which BreakdownPanel deliberately does not fold in, and BreakdownPanel's own
 * row. They are `class="bg-bar"` now, and the inline style carries only the
 * width, which is the one thing that varies per row.
 *
 * The reason this is a test and not just an edit: `bg-bar` is not a shortcut,
 * it is the `bar` entry in `theme.extend.colors` in config/crosswind.ts, and it
 * reaches the page only through the Crosswind merge. If that entry were renamed
 * or dropped, `class="bg-bar"` would generate nothing at all and all eleven bars
 * would render invisible against the panel. The rows would still lay out, the
 * numbers would still be right, and nothing else would fail: the dashboard would
 * simply stop showing proportion. So the assertions below are on the GENERATED
 * declarations, not on the config object.
 *
 * Follows tests/unit/empty-row.test.ts, including why generation is driven from
 * markup rather than by naming the class: production runs `buddy serve`, which
 * generates per request from rendered output, and the dashboard is auth-walled
 * so these bars never appear in dist/ for the SSG build to check.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import theme from '../../config/crosswind'
// The installed STX package does not export these subpaths by bare specifier.
import { loadCssEngine } from '../../node_modules/@stacksjs/stx/dist/dev-server/ts-css.js'
import { mergeCssConfig } from '../../node_modules/@stacksjs/stx/dist/ts-css-config.js'

/**
 * The marketing sheet. It was public/marketing.css until it moved into the
 * MARKETING preflight in config/crosswind.ts, scoped to the marketing layout
 * group (stx-standards rule 3, §11.2). Nesting did not rewrite the rules, so
 * what these assertions read is unchanged -- except that it is layered now,
 * which is the point several of them turn on.
 */
function marketingCss(): string {
  return ((theme as { preflights?: { getCSS: () => string }[] }).preflights ?? [])
    .map(entry => entry.getCSS())
    .find(css => css.includes('content="marketing"')) ?? ''
}

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/*
 * The class order here is pickier's, not a preference. These strings pin an
 * exact ordered class attribute, and `pickier --fix` sorts class attributes, so
 * `rounded bg-bar` became `bg-bar rounded` when the inline-style sweep ran the
 * linter over these two files. The assertions are unchanged in intent: one
 * shared token, no inline colour, and the width still inline because it is the
 * part that varies. Re-sorting is what to do if the linter moves them again.
 */
const CALLERS = {
  'resources/views/dashboard.stx': 10,
  'resources/components/BreakdownPanel.stx': 1,
} as const

describe('the shared breakdown bar', () => {
  test('every bar uses the token and none carries the colour inline', () => {
    for (const [path, count] of Object.entries(CALLERS)) {
      const source = read(path)
      expect(source.match(/class="absolute inset-y-1 left-0 bg-bar rounded"/g) ?? [], path).toHaveLength(count)
      // The bar's own inline colour. `.ga-row:hover` and `.drp-day.is-range`
      // legitimately still declare this in CSS, so the needle is the inline
      // form the bar divs used, not the value.
      expect(source, path).not.toContain('%; background: var(--bar);"')
    }
  })

  test('each bar still computes its own width inline, which is the part that varies', () => {
    // The point of the change was to remove what was identical, not to lose
    // what is not. A bar with no width is a bar nobody can read.
    const source = read('resources/views/dashboard.stx')
    const widths = source.match(/class="absolute inset-y-1 left-0 bg-bar rounded" style="width: \{\{ [^}]+\}\}%"/g) ?? []

    expect(widths).toHaveLength(CALLERS['resources/views/dashboard.stx'])
  })

  test('the generated rule is the declaration the call sites used to carry', async () => {
    const engine = await loadCssEngine()
    if (!engine)
      throw new Error('The installed STX CSS engine is required')
    const config = mergeCssConfig(engine.defaultConfig || engine.config, theme).config

    const markup = '<div class="ga-row"><div class="absolute inset-y-1 left-0 rounded bg-bar" style="width: 40%"></div></div>'
    const extract = engine.extractClasses
    if (!extract)
      throw new Error('The installed STX CSS engine is required')
    const extracted = [...extract(markup)]
    expect(extracted).toContain('bg-bar')

    const generator = new engine.CSSGenerator(config)
    for (const name of extracted)
      generator.generate(name)
    const css = generator.toCSS(false, false)

    expect(css).toContain('.bg-bar {')
    expect(css).toContain('background-color: var(--bar);')

    // The geometry stayed as utilities on purpose: translating them into a
    // hand-written class would copy Crosswind's scale into this app, where it
    // could drift from the engine that owns it. These are the values the bar
    // has always rendered at.
    expect(css).toContain('position: absolute;')
    expect(css).toContain('top: 0.25rem;')
    expect(css).toContain('bottom: 0.25rem;')
    expect(css).toContain('left: 0;')
    expect(css).toContain('border-radius: 0.25rem;')
  })

  test('nothing in the app declares a competing .bg-bar', () => {
    // Same reasoning as .empty-row: the marketing sheet is scoped and only
    // the marketing pages link it, so a declaration there would win on one page
    // and lose on another. The generated utility should be the only definition.
    for (const source of [marketingCss(), read('resources/views/dashboard.stx'), read('resources/views/visitor.stx')])
      expect(source).not.toMatch(/\.bg-bar\b/)
  })
})
