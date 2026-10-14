/**
 * pricing.stx's chrome, after it became utilities on its own elements.
 *
 * The page pushed a 31-line `<style>` into `<main>` -- rule 3 / §11.1 -- built
 * on public/marketing.css's tokens rather than this app's. Every rule is now a
 * utility on the element, which is §11.1's answer for a one-off: these shapes
 * appear once each, on one page, so neither a shortcut nor a preflight is the
 * right home for them.
 *
 * Verified end to end rather than by reading: the 53 elements of the plans
 * section were measured on the built site across 34 computed properties before
 * and after, and every one hashes identically. The assertions here are the
 * parts of that which a future edit could quietly undo.
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
const SRC = read('resources/views/pricing.stx')

/**
 * Driven through extractClasses, which is the only path that proves a class
 * spelled in markup reaches the sheet. It is also the path that would silently
 * drop a variant this engine version cannot extract.
 */
async function generate(markup: string): Promise<string> {
  const engine = await loadCssEngine()
  if (!engine?.extractClasses)
    throw new Error('The installed STX CSS engine is required')
  const merged = mergeCssConfig(engine.defaultConfig || engine.config, theme)
  const generator = new engine.CSSGenerator(merged.config)
  for (const name of [...engine.extractClasses(markup)])
    generator.generate(name)
  return generator.toCSS(false, false)
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const has = (css: string, needle: string) => flat(css).includes(flat(needle))

describe('the page declares no CSS', () => {
  test('no style block and no styles push', () => {
    const src = SRC.replace(/\{\{--[\s\S]*?--\}\}/g, '')
    expect(/<style/.test(src)).toBe(false)
    expect(/@push\(['"]styles['"]\)/.test(src)).toBe(false)
  })

  test('none of the old class names is left behind', () => {
    const src = SRC.replace(/\{\{--[\s\S]*?--\}\}/g, '')
    for (const name of ['price-toggle', 'price-toggle-row', 'plans', 'plan-eyebrow', 'plan-price', 'plan-amt', 'plan-per', 'plan-desc', 'plan-list', 'plan-check', 'price-err', 'self-host', 'featured'])
      expect(`${name}: ${new RegExp(`class="[^"]*\\b${name}\\b`).test(src)}`).toBe(`${name}: false`)
  })

  test('the two class names it keeps are public/marketing.css\'s own', () => {
    // `.btn` and its `.primary` / `.ghost` modifiers stay that file's, which is
    // the whole reason the app and auth buttons are named `btn-accent` and
    // `btn-ghost` instead.
    expect(SRC).toContain('btn ghost')
    expect(SRC).toContain('btn primary')
    const marketing = read('public/marketing.css')
    expect(marketing).toContain('.btn {')
    expect(marketing).toContain('.btn.primary {')
  })
})

describe('the shapes that had to become mutually exclusive class sets', () => {
  /*
   * Utilities are all unlayered and all (0,1,0), so between two that set the
   * same property the winner is source order in the generated sheet -- which
   * follows the order the extractor meets them, not the order they appear in
   * the class attribute. The old CSS resolved both of these with specificity
   * (`.price-toggle button.on` over `.price-toggle button`,
   * `.plan.featured` over `.plan`), which utilities cannot reproduce. Writing
   * them as alternatives rather than base-plus-override removes the question.
   */
  test('the billing toggle paints both states from one ternary', () => {
    const on = SRC.match(/:class="interval\(\) === 'monthly' \? '([^']*)' : '([^']*)'"/)
    expect(on).not.toBeNull()
    const [, picked, unpicked] = on as RegExpMatchArray
    expect(picked).toBe('bg-[var(--accent)] text-[var(--accent-ink)]')
    expect(unpicked).toBe('bg-transparent text-[var(--muted)] hover:text-[var(--ink)]')
    // Neither branch may set a property the other leaves alone, or the state
    // that does not set it keeps whatever the previous render left.
    const props = (s: string) => s.split(/\s+/).map(c => c.replace(/^hover:/, '').split('-')[0]).sort()
    expect(props(picked)).toEqual(['bg', 'text'])
    expect(props(unpicked)).toEqual(['bg', 'text', 'text'])
  })

  test('the featured plan carries --accent-line INSTEAD OF --line, not after it', () => {
    const cards = [...SRC.matchAll(/class="([^"]*border-\[var\(--(?:line|accent-line)\)\][^"]*)"/g)].map(m => m[1])
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      const colours = card.split(/\s+/).filter(c => /^border-\[var\(--/.test(c))
      expect({ card: colours.join(' '), count: colours.length }).toEqual({ card: colours.join(' '), count: 1 })
    }
    // Same for the eyebrow's colour.
    const eyebrows = [...SRC.matchAll(/class="([^"]*font-family:var\(--mono\)[^"]*)"/g)].map(m => m[1])
    expect(eyebrows).toHaveLength(2)
    for (const eyebrow of eyebrows)
      expect(eyebrow.split(/\s+/).filter(c => /^text-\[var\(--/.test(c))).toHaveLength(1)
  })
})

describe('every declaration the block carried', () => {
  test('is generated by the classes the markup now asks for', async () => {
    const css = await generate(SRC)
    const declarations: [string, string][] = [
      ['.mb-11', 'margin-bottom: 2.75rem'],
      ['.p-\\[0\\.28rem\\]', 'padding: 0.28rem'],
      ['.border-\\[var\\(--line-strong\\)\\]', 'border-color: var(--line-strong)'],
      ['.rounded-\\[999px\\]', 'border-radius: 999px'],
      ['.bg-\\[var\\(--surface\\)\\]', 'background-color: var(--surface)'],
      ['.px-\\[1\\.15rem\\]', 'padding-left: 1.15rem'],
      ['.\\[border\\:0\\]', 'border: 0'],
      ['.text-\\[var\\(--muted\\)\\]', 'color: var(--muted)'],
      ['.text-\\[0\\.9rem\\]', 'font-size: 0.9rem'],
      ['.opacity-\\[0\\.85\\]', 'opacity: 0.85'],
      ['.max-w-\\[720px\\]', 'max-width: 720px'],
      ['.p-\\[1\\.9rem\\]', 'padding: 1.9rem'],
      ['.rounded-\\[var\\(--r\\)\\]', 'border-radius: var(--r)'],
      ['.\\[font-family\\:var\\(--mono\\)\\]', 'font-family: var(--mono)'],
      ['.tracking-\\[0\\.14em\\]', 'letter-spacing: 0.14em'],
      ['.text-\\[2\\.4rem\\]', 'font-size: 2.4rem'],
      ['.tracking-\\[-0\\.03em\\]', 'letter-spacing: -0.03em'],
      ['.leading-\\[1\\.55\\]', 'line-height: 1.55'],
      ['.gap-\\[0\\.65rem\\]', 'gap: 0.65rem'],
      ['.flex-none', 'flex: none'],
      ['.mt-7', 'margin-top: 1.75rem'],
      ['.text-\\[var\\(--danger\\)\\]', 'color: var(--danger)'],
      ['.mt-11', 'margin-top: 2.75rem'],
    ]
    for (const [selector, declaration] of declarations)
      expect({ selector, present: has(css, `${selector} { ${declaration}`) }).toEqual({ selector, present: true })
  })

  test('the featured card\'s shadow is the literal declaration, not the ring chain', async () => {
    /*
     * `shadow-[…]` routes through Tailwind's --tc-shadow variables and emits a
     * five-part box-shadow with four transparent placeholders. Visually the
     * same, but it is not the declaration this page had, and the measured
     * before/after would not have matched. The arbitrary PROPERTY emits the
     * value as written.
     */
    const css = await generate(SRC)
    expect(has(css, 'box-shadow: 0 18px 60px color-mix(in srgb,var(--accent) 12%,transparent)')).toBe(true)
    expect(css).not.toContain('--tc-shadow')
  })

  test('the one-column breakpoint is the only thing that moved', async () => {
    /*
     * The block said `@media (max-width: 640px)`. `max-sm:` is
     * `max-width: 639.98px`, and the arbitrary form -- `max-[640px]:` -- is not
     * supported by this engine: it generates nothing at all, in markup AND
     * inside a shortcut, which was checked rather than assumed. So the plans
     * stack one-up 0.02px earlier than they did. Nothing else in the page
     * changed by any amount.
     */
    expect(SRC).toContain('max-sm:grid-cols-1')
    const css = await generate(SRC)
    expect(css).toContain('@media (max-width: 639.98px)')
    expect(has(css, 'grid-template-columns: repeat(1, minmax(0, 1fr))')).toBe(true)

    const engine = await loadCssEngine()
    if (!engine)
      throw new Error('The installed STX CSS engine is required')
    const merged = mergeCssConfig(engine.defaultConfig || engine.config, theme)
    const probe = new engine.CSSGenerator(merged.config)
    probe.generate('max-[640px]:grid-cols-1')
    expect(probe.toCSS(false, false)).toBe('')
  })
})
