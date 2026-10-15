/**
 * /dashboard's stylesheet, after it stopped being a `<style>` block.
 *
 * 178 rules pushed into `<main>` -- the last one in resources/, and more than
 * half the app's hand-written CSS on its own. It is `DASHBOARD_CSS` in
 * config/crosswind.ts now, which is what rule 3 / §11.1 asks for.
 *
 * It stays raw CSS rather than becoming utilities, and the config says why at
 * length: ts-maps writes the tooltip and map-pin markup from JavaScript long
 * after the extractor has read the page, `::-webkit-details-marker`,
 * `@supports not (...)` and `~` have no utility form, and the two media queries
 * are exact where the engine's own breakpoints are 1023.98px and 767.98px.
 *
 * What this file pins is the part that could regress silently: the cascade
 * direction reversed when the CSS moved, and the preflight now reaches 37 pages
 * instead of one.
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
// Site-wide entries only. MARKETING joined `preflights` when
// public/marketing.css moved into the config, but it is scoped to a layout
// group and is not what this file means by "the preflight".
const SECTIONS = ((theme as { preflights?: { getCSS: () => string }[] }).preflights ?? [])
  .map(e => e.getCSS())
  .filter(css => !css.includes('content="marketing"'))
/** The four sections are TOKENS, CHROME, APP_VIEWS, DASHBOARD_CSS, in cascade order. */
const PREFLIGHT = SECTIONS.join('\n')
const DASHBOARD = SECTIONS[3] ?? ''

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const has = (css: string, needle: string) => flat(css).includes(flat(needle))

/** [selector, declarations] for every rule, with its enclosing at-rule. */
function rules(css: string): { sel: string, body: string, at: string }[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { sel: string, body: string, at: string }[] = []
  let i = 0
  let at = ''
  let depth = 0
  while (i < stripped.length) {
    const open = stripped.indexOf('{', i)
    const close = stripped.indexOf('}', i)
    if (open === -1)
      break
    if (close !== -1 && close < open) {
      if (depth > 0) {
        depth--
        at = ''
      }
      i = close + 1
      continue
    }
    const head = stripped.slice(i, open).trim()
    if (head.startsWith('@')) {
      at = head
      depth++
      i = open + 1
      continue
    }
    const end = stripped.indexOf('}', open)
    out.push({ sel: head.replace(/\s+/g, ' '), body: stripped.slice(open + 1, end).trim(), at })
    i = end + 1
  }
  return out
}

describe('the view declares no CSS', () => {
  test('dashboard.stx has no style block', () => {
    const src = read('resources/views/dashboard.stx').replace(/\{\{--[\s\S]*?--\}\}/g, '')
    expect(/<style/.test(src)).toBe(false)
    expect(/--[a-z0-9-]+\s*:/.test(src)).toBe(false)
  })

  test('the styles push survives, carrying only ts-maps\' stylesheet', () => {
    // The <link> has to stay: tests/unit/no-third-party-assets.test.ts fails the
    // build on a CDN, so the map's CSS is served from /vendor, and it is loaded
    // from this page rather than the layout because nothing else uses the map.
    const src = read('resources/views/dashboard.stx')
    const push = /@push\(['"]styles['"]\)([\s\S]*?)@endpush/.exec(src)
    expect(push).not.toBeNull()
    const body = (push as RegExpExecArray)[1].replace(/\{\{--[\s\S]*?--\}\}/g, '')
    expect(body).toContain('/vendor/ts-maps.css')
    expect(/<style/.test(body)).toBe(false)
  })

  test('no .stx file in resources/ declares CSS any more', () => {
    // Comments stripped first: these files discuss `<style>` in prose, and a
    // grep for the opening tag counts those sentences -- the last census of
    // this estate said 47 files when the real number was 38.
    const { globSync } = require('node:fs') as { globSync: (p: string, o: { cwd: string }) => string[] }
    const found = globSync('resources/**/*.stx', { cwd: ROOT })
      .filter(p => /^\s*<style[\s>]/m.test(read(p).replace(/\{\{--[\s\S]*?--\}\}/g, '')))
    expect(found).toEqual([])
  })
})

describe('the rules that moved', () => {
  test('the constructs that kept it out of utilities are all still here', () => {
    const needles = [
      // ts-maps writes these nodes from JavaScript; the extractor never sees them.
      '.ga-tip',
      '#country-map .live-pin',
      // No utility form at all.
      '::-webkit-details-marker',
      '@supports not (background: color-mix(in srgb, red, blue))',
      '.site-settings-shell:not([open]) ~ .site-settings-panel',
      // Exact breakpoints. `max-lg:` and `max-md:` are 1023.98px and 767.98px.
      '@media (max-width: 1023px)',
      '@media (max-width: 767px)',
      // Written onto looped elements by the date picker's own signals.
      '.drp-day.is-range',
      '.range-tool.is-active',
    ]
    for (const needle of needles)
      expect({ needle, present: PREFLIGHT.includes(needle) }).toEqual({ needle, present: true })
  })

  test('the arbitrary max-width variant really does generate nothing', async () => {
    // The reason the breakpoints could not be utilities. Asserted rather than
    // assumed, because if a later engine version starts supporting it this
    // file should be the thing that says so.
    const engine = await loadCssEngine()
    if (!engine)
      throw new Error('The installed STX CSS engine is required')
    const merged = mergeCssConfig(engine.defaultConfig || engine.config, theme)
    for (const cls of ['max-[1023px]:hidden', 'max-[767px]:items-center']) {
      const gen = new engine.CSSGenerator(merged.config)
      gen.generate(cls)
      expect({ cls, css: gen.toCSS(false, false) }).toEqual({ cls, css: '' })
    }
  })

  test('the two declarations that had to leave their call sites did', () => {
    /*
     * The cascade direction reverses: a pushed <style> sits after the generated
     * sheet and is unlayered, so it beat the utilities beside it; a preflight
     * is layered and loses to all of them. Every one of the 178 rules was
     * checked against every call site carrying one of its class names,
     * property by property, and exactly these two overlapped.
     */
    expect(has(PREFLIGHT, '.ga-row-label { color: var(--text-2); }')).toBe(true)
    expect(has(PREFLIGHT, '.ga-row:hover .ga-row-label { color: var(--text); }')).toBe(true)
    expect(has(PREFLIGHT, '.kpi-value { font-size: 1.875rem; line-height: 2.25rem; }')).toBe(true)

    for (const path of ['resources/views/dashboard.stx', 'resources/components/BreakdownPanel.stx']) {
      const src = read(path)
      for (const [carrier, utility] of [['ga-row-label', 'text-text-2'], ['kpi-value', 'text-3xl']]) {
        for (const site of src.match(new RegExp(`class="[^"]*\\b${carrier}\\b[^"]*"`, 'g')) ?? [])
          expect({ site, clash: site.includes(utility) }).toEqual({ site, clash: false })
      }
    }
  })

  test('the hover rule outranks the base colour inside the layer', () => {
    // Specificity still decides between two rules in the same layer, so the
    // (0,2,0) descendant beats the (0,1,0) -- which is the whole point of
    // moving the base colour off the element.
    const all = rules(PREFLIGHT)
    const base = all.findIndex(r => r.sel === '.ga-row-label')
    const hover = all.findIndex(r => r.sel === '.ga-row:hover .ga-row-label')
    expect(base).toBeGreaterThan(-1)
    expect(hover).toBeGreaterThan(base)
  })
})

describe('nothing leaks onto the 28 marketing pages', () => {
  /*
   * This preflight is served on every page, and the marketing sheet is
   * unlayered, so it wins for every property it declares on a shared class --
   * and loses for every property it does not. Its `.bar` is a flex track with
   * no animation, so an unscoped `.bar { animation: grow }` here would have
   * started animating the marketing bars; its `.live-dot` has no ::after, so
   * ours would have added a second pulsing halo to a dot that already pulses.
   *
   * Measured on the built site, both directions: on /dashboard a fresh
   * `<div class="bar">` computes `animation-name: grow` and a `.live-dot`
   * gets the halo; on / the same elements compute `none` and `content: none`,
   * and `.reveal` runs marketing.css's own `reveal-in`.
   */
  const marketingClasses = (() => {
    const css = marketingCss()
    const out = new Set<string>()
    for (const r of css.matchAll(/([^{}]+)\{/g)) {
      const sel = r[1].trim()
      if (sel.startsWith('@'))
        continue
      for (const c of sel.matchAll(/\.([a-zA-Z][\w-]*)/g))
        out.add(c[1])
    }
    return out
  })()

  test('every rule naming a class marketing.css also declares is scoped to the app group', () => {
    const unscoped: string[] = []
    for (const { sel } of rules(DASHBOARD)) {
      for (const part of sel.split(',')) {
        const names = [...part.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1])
        const shared = names.filter(n => marketingClasses.has(n))
        if (shared.length && !part.includes('stx-layout-group'))
          unscoped.push(`${part.trim()}  (shares ${shared.join(', ')})`)
      }
    }
    expect(unscoped).toEqual([])
  })

  test('the two shared names in the chrome above are safe for a different reason', () => {
    /*
     * The invariant above is DASHBOARD_CSS's alone, because the two sections
     * before it cannot satisfy it and do not need to.
     *
     * CHROME's `.theme-toggle-btn .ic-moon` and `.ic-sun` name classes
     * marketing.css also styles, but only as descendants of
     * `.theme-toggle-btn`, which is resources/components/ThemeToggle.stx and
     * renders on app and auth pages only -- marketing.css styles its own nav
     * toggle as `.theme-toggle`, a different element. Scoping them to the app
     * group would break the auth pages' toggle.
     *
     * APP_VIEWS' `.panel` is safe by layering alone: marketing.css declares
     * background, border, border-radius AND padding on `.panel`, which covers
     * every property this rule sets, so the layered copy loses all of them.
     * Measured on the built homepage: #101317 at marketing.css's 18.4px
     * padding, not this rule's values.
     */
    const chrome = rules(SECTIONS.slice(0, 3).join('\n'))
      .filter(r => !r.sel.includes('stx-layout-group'))
      .filter(r => r.sel.split(',').some(part => [...part.matchAll(/\.([a-zA-Z][\w-]*)/g)].some(m => marketingClasses.has(m[1]))))
      .map(r => r.sel)
    expect(chrome).toEqual([
      '.theme-toggle-btn .ic-moon, :root[data-theme="light"] .theme-toggle-btn .ic-sun',
      ':root[data-theme="light"] .theme-toggle-btn .ic-moon',
      '.panel',
    ])
    const marketing = marketingCss()
    for (const prop of ['background', 'border', 'border-radius'])
      expect({ prop, declared: new RegExp(`\\.panel \\{[^}]*${prop}:`).test(marketing.replace(/\s+/g, ' ')) }).toEqual({ prop, declared: true })
  })

  test('the six shared names are the ones we think they are', () => {
    // If marketing.css grows a name this file already uses, the test above
    // fails; this one says which names the scoping currently exists for, so
    // the diff is readable when that happens.
    const scoped = rules(DASHBOARD).filter(r => r.sel.includes('stx-layout-group'))
    const names = new Set(scoped.flatMap(r => [...r.sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1])))
    const shared = [...names].filter(n => marketingClasses.has(n)).sort()
    expect(shared).toEqual(['bar', 'ic-moon', 'ic-sun', 'live-dot', 'panel', 'reveal'])
    // And the sixteen others the scoping sweeps up with them, which cost nothing.
    expect(scoped.length).toBeGreaterThanOrEqual(11)
  })

  test('the keyframes it adds are named outside the marketing sheet\'s set', () => {
    /*
     * A same-named @keyframes elsewhere in the sheet replaces rather than
     * merges, so a shared name is a silent, page-dependent swap of one
     * animation for another. This mattered more once both sets landed in ONE
     * generated sheet: they used to be in two files.
     */
    const mine = [...PREFLIGHT.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]).sort()
    const theirs = new Set([...marketingCss().matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]))
    expect(mine).toEqual(['grow', 'livepulse', 'reveal', 'skeleton-pulse'])
    expect(mine.filter(n => theirs.has(n))).toEqual([])
  })
})
