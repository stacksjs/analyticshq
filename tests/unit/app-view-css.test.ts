/**
 * account.stx's and visitor.stx's chrome, after it moved out of their
 * `@push('styles')` blocks.
 *
 * Both pushed a `<style>` into `<main>`, which is what rule 3 / §11.1 forbids.
 * Between them they declared `.btn` three different ways -- account's
 * base-plus-modifier pair and visitor's bordered one -- on top of the auth
 * layout's filled button and public/marketing.css's. Measured declaration by
 * declaration they were two buttons, not four: account's `.btn.btn-primary`
 * matched the auth layout's, and account's `.btn.btn-ghost` matched visitor's
 * `.btn`, down to the colour stops in the hover `color-mix`. The transition
 * lists differed, each one naming only the properties its own page animated,
 * so the shared pair takes the union.
 *
 * ## The cascade direction flipped, and that is why the call sites matter
 *
 * A pushed `<style>` lands inside `<main>`, AFTER the generated sheet, and is
 * unlayered -- so it used to beat the utilities on the same element at equal
 * specificity. A preflight is layered and loses to all of them. The flip is
 * invisible only because no call site sets a property these rules set, which
 * is checked below rather than assumed.
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

async function generate(markup: string): Promise<string> {
  const engine = await loadCssEngine()
  if (!engine?.extractClasses)
    throw new Error('The installed STX CSS engine is required')
  const merged = mergeCssConfig(engine.defaultConfig || engine.config, theme)
  const generator = new engine.CSSGenerator(merged.config)
  for (const name of [...engine.extractClasses(markup)])
    generator.generate(name)
  return generator.toCSS(merged.includePreflight, false)
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const has = (css: string, needle: string) => flat(css).includes(flat(needle))

/** Every class token either view asks for, including inside `:class=`. */
function classes(path: string): string[] {
  const src = read(path).replace(/\{\{--[\s\S]*?--\}\}/g, '')
  return [...src.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)).filter(Boolean)
}

describe('neither view declares CSS any more', () => {
  test('no style block and no styles push', () => {
    for (const view of ['account', 'visitor']) {
      const src = read(`resources/views/${view}.stx`).replace(/\{\{--[\s\S]*?--\}\}/g, '')
      expect(`${view}: ${/<style/.test(src)}`).toBe(`${view}: false`)
      expect(`${view}: ${/@push\(['"]styles['"]\)/.test(src)}`).toBe(`${view}: false`)
    }
  })

  test('neither view declares a custom property', () => {
    for (const view of ['account', 'visitor']) {
      const src = read(`resources/views/${view}.stx`).replace(/\{\{--[\s\S]*?--\}\}/g, '')
      expect(`${view}: ${/--[a-z0-9-]+\s*:/.test(src)}`).toBe(`${view}: false`)
    }
  })
})

describe('the two buttons, not four', () => {
  test('neither view asks for .btn, .btn-primary or .stat-label any more', () => {
    for (const view of ['account', 'visitor'])
      for (const gone of ['btn', 'btn-primary', 'stat-label', 'row', 'step'])
        expect(`${view}/${gone}: ${classes(`resources/views/${view}.stx`).includes(gone)}`).toBe(`${view}/${gone}: false`)
  })

  test('btn-ghost carries what account and visitor each spelled separately', async () => {
    const css = await generate('<a class="px-3.5 py-2 text-sm btn-ghost">Change</a>')
    const rules = [
      '.btn-ghost { border-width: 1px; border-style: solid; border-color: var(--border); border-radius: 10px; color: var(--text); font-weight: 600; transition: border-color 0.15s ease,transform 0.12s ease,opacity 0.15s ease,background-color 0.15s ease; }',
      '.btn-ghost:hover { border-color: color-mix(in srgb,var(--accent) 45%,var(--border)); }',
      '.btn-ghost:active { transform: translateY(1px); }',
    ]
    for (const rule of rules)
      expect({ rule, present: has(css, rule) }).toEqual({ rule, present: true })
  })

  test('btn-danger is a whole button and never needs btn-ghost beside it', async () => {
    /*
     * As a modifier it would have had to beat `btn-ghost:hover` at the same
     * specificity, which holds only while the two names stay in that order in
     * the class attribute -- and pickier's sort-tailwind-classes rule is
     * entitled to reorder them, at which point the destructive button quietly
     * loses its red.
     */
    const css = await generate('<button class="flex gap-1.5 items-center px-3 py-1.5 text-sm btn-danger">Erase</button>')
    expect(has(css, '.btn-danger { border-width: 1px; border-style: solid; border-color: var(--border); border-radius: 10px; color: var(--text); font-weight: 600;')).toBe(true)
    expect(has(css, '.btn-danger:hover { border-color: var(--bad); color: var(--bad); }')).toBe(true)
    expect(has(css, '.btn-danger:active { transform: translateY(1px); }')).toBe(true)

    const visitor = classes('resources/views/visitor.stx')
    expect(visitor).toContain('btn-danger')
    const danger = read('resources/views/visitor.stx').match(/class="[^"]*btn-danger[^"]*"/g) ?? []
    for (const site of danger)
      expect({ site, pairedWithGhost: site.includes('btn-ghost') }).toEqual({ site, pairedWithGhost: false })
  })
})

describe('the surfaces and the timeline', () => {
  test('every rule the two blocks carried survives the trip', async () => {
    const markup = '<div class="mb-5 p-6 card"><span class="ml-1 px-2 py-0.5 badge badge-pro">Pro</span>'
      + '<img class="h-14 w-14 avatar"><div class="skeleton"></div>'
      + '<div class="flex items-center justify-between px-6 py-4 row-rule"></div>'
      + '<p class="mt-1 font-semibold text-2xl mono">42</p><div class="stat-key">First seen</div>'
      + '<div class="ml-1 mt-3 pl-4 step-rail"><div class="flex gap-3 items-baseline py-1 text-sm step-row" data-kind="conversion"></div></div>'
      + '<section class="p-5 panel visit"></section></div>'
    const css = await generate(markup)
    const rules = [
      '.card { background-color: var(--panel, var(--surface)); border-width: 1px; border-style: solid; border-color: var(--border); border-radius: 14px; }',
      '.badge { border-width: 1px; border-style: solid; border-color: var(--border); border-radius: 999px; font-family: var(--mono); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-2); }',
      '.badge-pro { border-color: var(--accent); color: var(--accent-text); }',
      '.avatar { border-radius: 999px; object-fit: cover; background-color: color-mix(in srgb,var(--accent) 14%,var(--panel)); }',
      '.row-rule { border-top-width: 1px;',
      '.skeleton { background-color: color-mix(in srgb,var(--text-3) 20%,transparent); border-radius: 6px; animation: skeleton-pulse 1.4s ease-in-out infinite; }',
      '.mono { font-family: var(--mono); font-feature-settings: \'tnum\' 1; }',
      '.stat-key { font-family: var(--mono); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }',
      '.step-rail { border-left-width: 1px;',
      '.step-row { position: relative; }',
      '.step-row::before { content: \'\'; position: absolute; left: -20px; top: 11px; width: 7px; height: 7px; border-radius: 999px; background-color: var(--border); }',
      '.step-row[data-kind=conversion]::before { background-color: var(--accent); }',
      '.step-row[data-kind=event]::before { background-color: var(--text-3); }',
      // Preflight, not shortcut -- see the config.
      '.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; }',
      '.visit + .visit { margin-top: 12px; }',
      '@keyframes skeleton-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 0.9; } }',
    ]
    for (const rule of rules)
      expect({ rule, present: has(css, rule) }).toEqual({ rule, present: true })
  })

  test('the skeleton still stops for prefers-reduced-motion', async () => {
    /*
     * Found by its own contents rather than by taking the first
     * `prefers-reduced-motion` block in the sheet: DASHBOARD_CSS declares two
     * of its own ahead of this one, and the engine emits this rule from the
     * `motion-reduce:animate-none` utility after the whole preflight.
     */
    const css = await generate('<div class="skeleton"></div>')
    const blocks = [...flat(css).matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^@]*?)\}\s*\}/g)]
    const mine = blocks.filter(b => b[1].includes('.skeleton'))
    expect(mine).toHaveLength(1)
    expect(flat(mine[0][1])).toContain('.skeleton { animation: none;')
  })

  test('the keyframes are not called `pulse`', () => {
    /*
     * public/marketing.css already has an unlayered `@keyframes pulse` driving
     * its live dot, and @keyframes obey layers: an unlayered set beats a
     * layered one of the same name. Sharing the name would be a silent,
     * page-dependent swap of one animation for the other.
     */
    expect(read('public/marketing.css')).toContain('@keyframes pulse')
    const preflight = ((theme as { preflights?: { getCSS: () => string }[] }).preflights ?? [])
      .map(e => e.getCSS()).join('\n')
    expect(preflight).toContain('@keyframes skeleton-pulse')
    expect(preflight).not.toMatch(/@keyframes pulse\b/)
  })
})

describe('the names public/marketing.css also claims', () => {
  const marketing = read('public/marketing.css')

  test('a claimed name is a preflight, never a shortcut', () => {
    /*
     * The two vehicles do opposite things on a marketing page: a preflight is
     * layered and loses to that unlayered file, a shortcut is unlayered and
     * served after it, so it wins. `.panel` is declared in both places and has
     * to lose; `.stat-label` is declared in both and could not be made to lose
     * for the three properties marketing.css does not set, so visitor's copy
     * was renamed instead.
     */
    const shortcuts = Object.keys((theme as { shortcuts?: Record<string, string> }).shortcuts ?? {})
    for (const name of shortcuts) {
      const claimed = new RegExp(`(^|[\\s,>+~{])\\.${name}([\\s,:.>+~{]|$)`, 'm').test(marketing)
      expect(`${name} claimed by marketing.css: ${claimed}`).toBe(`${name} claimed by marketing.css: false`)
    }
  })

  test('.panel and .stat-label stay marketing.css\'s on a marketing page', () => {
    for (const name of ['.panel', '.stat-label'])
      expect(`${name}: ${marketing.includes(`${name} {`)}`).toBe(`${name}: true`)
    // visitor.stx's version of the label is under a name that file never uses.
    expect(marketing).not.toMatch(/\.stat-key\b/)
  })
})

describe('the call sites the preflight now loses to', () => {
  test('none of them sets a property these rules set', () => {
    /*
     * The one measurement the whole migration rests on. Before, a pushed
     * `<style>` sat after the generated sheet and beat the utilities beside
     * it; now the preflight is layered and loses to every one of them. That is
     * invisible only while no call site declares background, border, radius,
     * font-family, letter-spacing or text-transform itself.
     */
    const OWNED = /^(bg-|border(-|$)|rounded|font-(mono|sans|serif)|tracking-|uppercase$|lowercase$|capitalize$|normal-case$|object-)/
    const CARRIERS = new Set(['panel', 'card', 'badge', 'badge-pro', 'avatar', 'row-rule', 'skeleton', 'mono', 'stat-key', 'step-rail', 'step-row', 'btn-ghost', 'btn-danger', 'btn-accent', 'visit'])
    for (const view of ['account', 'visitor']) {
      const src = read(`resources/views/${view}.stx`).replace(/\{\{--[\s\S]*?--\}\}/g, '')
      for (const m of src.matchAll(/class="([^"]*)"/g)) {
        const tokens = m[1].split(/\s+/).filter(Boolean)
        if (!tokens.some(t => CARRIERS.has(t)))
          continue
        const clashes = tokens.filter(t => !CARRIERS.has(t) && OWNED.test(t))
        expect({ site: m[1], clashes }).toEqual({ site: m[1], clashes: [] })
      }
    }
  })
})
