/**
 * The empty-list placeholder every panel shares.
 *
 * Thirteen sites carried `py-8 text-center text-sm text-text-3` as four
 * separate utilities, byte-identical in all thirteen: the `@empty` branch of
 * each forelse on the dashboard, the `@else` of the country map, and
 * BreakdownPanel's own. They are `class="empty-row"` now.
 *
 * The reason this is a test and not just a config entry: a shortcut lives in
 * config/crosswind.ts, which only reaches the page through the Crosswind merge.
 * If the entry were renamed or dropped, `class="empty-row"` would generate
 * nothing at all and all thirteen placeholders would render unstyled, left
 * aligned at full size with no padding. Nothing else would fail. So the
 * assertions below are on the GENERATED declarations, not on the config object.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import theme from '../../config/crosswind'
// The installed STX package does not export these subpaths by bare specifier.
import { loadCssEngine } from '../../node_modules/@stacksjs/stx/dist/dev-server/ts-css.js'
import { mergeCssConfig } from '../../node_modules/@stacksjs/stx/dist/ts-css-config.js'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const CALLERS = {
  'resources/views/dashboard.stx': 12,
  'resources/components/BreakdownPanel.stx': 1,
} as const

describe('the shared empty-list placeholder', () => {
  test('every caller uses the shortcut and none spells the utilities out', () => {
    for (const [path, count] of Object.entries(CALLERS)) {
      const source = read(path)
      expect(source.match(/class="empty-row"/g) ?? []).toHaveLength(count)
      expect(source).not.toContain('py-8 text-center text-sm text-text-3')
    }
  })

  test('the generated rule is the four declarations the call sites used to carry', async () => {
    const engine = await loadCssEngine()
    if (!engine)
      throw new Error('The installed STX CSS engine is required')
    const config = mergeCssConfig(engine.defaultConfig || engine.config, theme).config

    /*
     * Driven from MARKUP through extractClasses, not by calling generate() with
     * the name, because that is the path the serve takes: production runs
     * `buddy serve`, which generates per request from the rendered output. The
     * dashboard is auth-walled, so the SSG build renders its signed-out shell
     * and these placeholders never appear in dist/ at all; extraction is the
     * only place the whole chain can be checked.
     */
    const markup = '<div class="panel"><div class="empty-row">No pages yet.</div></div>'
    const extract = engine.extractClasses
    if (!extract)
      throw new Error('The installed STX CSS engine is required')
    const extracted = [...extract(markup)]
    expect(extracted).toContain('empty-row')

    const generator = new engine.CSSGenerator(config)
    for (const name of extracted)
      generator.generate(name)
    const css = generator.toCSS(false, false)

    // py-8, text-center, text-sm (size AND line-height, which is easy to lose
    // when a composite is hand-written), text-text-3.
    expect(css).toContain('.empty-row {')
    expect(css).toContain('padding-top: 2rem;')
    expect(css).toContain('padding-bottom: 2rem;')
    expect(css).toContain('text-align: center;')
    expect(css).toContain('font-size: 0.875rem;')
    expect(css).toContain('line-height: 1.25rem;')
    expect(css).toContain('color: var(--text-3);')
  })

  test('nothing in the app declares a competing .empty-row', () => {
    /*
     * The name sits outside the `panel-*` family deliberately. Every one of
     * these placeholders is inside a `.panel`, but `panel-head` and `panel-tag`
     * are declared in public/marketing.css, and a `panel-empty` shortcut would
     * not lose to that file on a marketing page -- it would WIN, which is
     * worse. Both are unlayered and the generated sheet is linked after
     * /marketing.css, so the later rule takes it (corrected: this comment used
     * to claim the shortcut lost). This asserts the name stays unclaimed.
     */
    for (const path of ['public/marketing.css', 'resources/views/dashboard.stx', 'resources/views/visitor.stx'])
      expect(read(path)).not.toMatch(/\.empty-row\b/)
  })
})
