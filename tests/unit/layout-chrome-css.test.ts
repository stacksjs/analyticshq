/**
 * The two layouts' chrome, after it moved out of their `<style>` blocks.
 *
 * resources/layouts/app.stx and resources/layouts/auth.stx each carried a
 * `<style>` block in `@head`: a `:root` palette, a `body` rule, `.wordmark`,
 * ThemeToggle's ten rules, and (auth only) the form controls. That is what
 * stx-standards rule 3 / §11.1 forbids, and the palette is what §11.2 says
 * belongs in config/crosswind.ts exactly once. The palette and the chrome are
 * a `preflights` entry there now; the controls are shortcuts.
 *
 * Why these assertions are on the GENERATED sheet and not on the config
 * object: a preflight or a shortcut only reaches the page through stx's
 * Crosswind merge. If an entry were renamed, dropped, or written in a shape
 * the engine quietly discards, every auth page would render unstyled on a
 * transparent background and nothing else in this suite would fail. So the
 * engine is loaded, the config is merged the way the render path merges it,
 * and the output is read.
 *
 * The engine is `@stacksjs/ts-css`, which is what stx's loadCssEngine()
 * resolves -- not `@cwcss/crosswind`, which only supplies the config's types.
 * Verifying against the wrong one proves nothing about what ships.
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

/**
 * The preflight alone, exactly as the engine receives it. Four entries --
 * TOKENS, CHROME, APP_VIEWS, DASHBOARD_CSS -- concatenated in cascade order,
 * which is how the engine joins them.
 */
function preflightCSS(): string {
  return ((theme as { preflights?: { getCSS: () => string }[] }).preflights ?? [])
    .map(e => e.getCSS()).join('\n')
}

/**
 * The whole sheet, through the real merge. Classes are driven from MARKUP via
 * extractClasses rather than handed to generate() by name, because that is the
 * path `buddy serve` takes: it generates per request from the rendered output.
 */
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

/** Whitespace-insensitive: the engine's own spacing is not the contract. */
function has(css: string, needle: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  return flat(css).includes(flat(needle))
}

describe('no layout declares CSS any more', () => {
  test('neither layout has a style block', () => {
    for (const name of ['app', 'auth', 'marketing']) {
      const src = read(`resources/layouts/${name}.stx`).replace(/\{\{--[\s\S]*?--\}\}/g, '')
      expect(`${name}: ${/<style/.test(src)}`).toBe(`${name}: false`)
    }
  })

  test('neither layout declares a custom property', () => {
    // §11.2's own check, scoped to the files this change covers.
    for (const name of ['app', 'auth', 'marketing']) {
      const src = read(`resources/layouts/${name}.stx`).replace(/\{\{--[\s\S]*?--\}\}/g, '')
      expect(`${name}: ${/--[a-z0-9-]+\s*:/.test(src)}`).toBe(`${name}: false`)
    }
  })
})

describe('the palettes', () => {
  const css = preflightCSS()

  test('each one is keyed off the layout group stx emits, not :root', () => {
    /*
     * One generated sheet serves every page. A bare `:root` palette would put
     * the app's white `--panel` on the 28 marketing pages, where the point of
     * the `var(--panel, var(--surface))` fallbacks in theme.extend.colors is
     * that `--panel` is undefined and marketing.css's `--surface` answers --
     * so defining it would turn every `bg-panel` there white.
     */
    expect(css).toContain('html:has(meta[name="stx-layout-group"][content="app"])')
    expect(css).toContain('html:has(meta[name="stx-layout-group"][content="auth"])')
    expect(css).not.toMatch(/(^|\n)\s*:root\s*\{/)
  })

  test('the marketing group is named by neither', () => {
    expect(css).not.toContain('content="marketing"')
  })

  test('the app palette is the emerald one, light by default', () => {
    expect(has(css, '--accent: #059669')).toBe(true)
    expect(has(css, '--panel: #ffffff')).toBe(true)
    expect(has(css, '--bar: rgba(5,150,105,0.16)')).toBe(true)
    // The four accessibility tokens the inline Tailwind 500s were replaced by.
    for (const token of ['--accent-text: #047857', '--good: #047857', '--bad: #c93434', '--warn: #b45309'])
      expect(has(css, token)).toBe(true)
  })

  test('the auth palette is the marketing one, dark by default', () => {
    expect(has(css, '--accent: #46d3c0')).toBe(true)
    expect(has(css, '--bg: #0a0c0e')).toBe(true)
    expect(has(css, '--danger: #f87171')).toBe(true)
  })

  test('both groups answer the OS and an explicit choice', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('@media (prefers-color-scheme: light)')
    for (const group of ['app', 'auth'])
      expect(css).toContain(`[content="${group}"])[data-theme="light"]`)
    expect(css).toContain('[content="app"])[data-theme="dark"]')
    // Auth is dark at its base, so the dark attribute only has to STOP the
    // light media query, which `:not()` does.
    expect(css).toContain('[content="auth"]):not([data-theme="dark"])')
  })

  test('an explicit light choice is declared after the dark media query', () => {
    // Both are (0,3,1) under the app group, so order is the whole of it: a
    // reader who picked light on a dark-preferring OS must still get light.
    const dark = css.indexOf('@media (prefers-color-scheme: dark)')
    const light = css.indexOf('[content="app"])[data-theme="light"]')
    expect(dark).toBeGreaterThan(-1)
    expect(light).toBeGreaterThan(dark)
  })

  test('no font family is double-quoted', () => {
    /*
     * Not style. A double-quoted font family inside a preflight makes this
     * engine substitute its own default stack and swallow the rules that
     * follow -- measured on ts-css, and the reason commshq's block is
     * single-quoted too. The whole of CHROME sits after these declarations.
     */
    expect(css).not.toMatch(/font-family:[^;]*"/)
    expect(css).not.toMatch(/--(?:sans|mono):[^;]*"/)
    expect(has(css, "--sans: 'Geist', ui-sans-serif, system-ui, sans-serif")).toBe(true)
    expect(has(css, "--mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace")).toBe(true)
  })
})

describe('the shared chrome, through the real merge', () => {
  test('every rule both layouts carried survives the trip', async () => {
    /*
     * These twelve were byte-identical in app.stx and auth.stx -- checked by
     * diffing the two spans, not by eye. Listed one declaration at a time so a
     * partial loss is a named failure rather than a missing substring.
     */
    const css = await generate('<main><span class="wordmark">analyticshq</span><button class="theme-toggle-btn"><i class="ic-sun"></i><i class="ic-moon"></i></button></main>')
    const rules: string[] = [
      'body { background: var(--bg); color: var(--text); font-family: var(--sans); -webkit-font-smoothing: antialiased; }',
      '.wordmark { font-weight: 700; letter-spacing: -0.03em; }',
      'border: 1px solid var(--border); border-radius: 10px; background: var(--panel); color: var(--text-2); cursor: pointer;',
      '.theme-toggle-btn:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }',
      '.theme-toggle-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
      '.theme-toggle-btn i { width: 1rem; height: 1rem; }',
      '.theme-toggle-btn .ic-moon, :root[data-theme="light"] .theme-toggle-btn .ic-sun { display: none; }',
      ':root[data-theme="light"] .theme-toggle-btn .ic-moon { display: block; }',
    ]
    for (const rule of rules)
      expect({ rule, present: has(css, rule) }).toEqual({ rule, present: true })
  })

  test('the body rule is scoped to the two groups that define --bg', async () => {
    const css = await generate('<main></main>')
    expect(has(css, '[content="app"]) body, html:has(meta[name="stx-layout-group"][content="auth"]) body {')).toBe(true)
  })

  test('the preflight lands in a layer, so a call site\'s utilities still win', async () => {
    /*
     * This is the whole reason a preflight is the right vehicle. An unlayered
     * rule beats a layered one at any specificity, so every utility and every
     * shortcut outranks everything above -- which is how the old `<style>` in
     * `@head` behaved relative to the generated sheet, and how the nine auth
     * call sites keep their `py-2.5 w-full font-semibold text-sm`.
     */
    const css = await generate('<main class="wordmark"></main>')
    /*
     * Anchored on the UTILITY's rule, not on `.wordmark` anywhere in the
     * sheet: the preflight declares `.wordmark` too, inside the layer, and
     * `indexOf` finds that one. The question is where the generated utility
     * lands relative to the last layer block.
     */
    const layer = css.lastIndexOf('@layer')
    const utility = css.indexOf('.wordmark {', css.lastIndexOf('}'))
    expect(layer).toBeGreaterThan(-1)
    expect(css.slice(layer).includes('.wordmark')).toBe(true)
    expect(utility === -1 ? css.lastIndexOf('.wordmark') : utility).toBeGreaterThan(layer)
  })
})

describe('the auth controls, as shortcuts', () => {
  /** Markup shaped like login.stx's, so extraction sees what the serve sees. */
  const MARKUP = '<form><input class="px-3.5 py-2.5 w-full text-sm field">'
    + '<p class="mb-4 py-2 err notice-box">no</p><p class="py-3 notice-box ok">yes</p>'
    + '<button class="py-2.5 w-full font-semibold text-sm btn-accent">Sign in</button>'
    + '<div class="my-5 divider">or</div>'
    + '<a class="py-2.5 w-full font-medium text-sm oauth-btn">GitHub</a></form>'

  test('each one generates the declarations its old rule carried', async () => {
    const css = await generate(MARKUP)
    const rules: string[] = [
      // .field
      '.field { background-color: var(--bg); border-width: 1px; border-style: solid; border-color: var(--border); border-radius: 10px; color: var(--text); }',
      '.field:focus { outline-style: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent); }',
      /*
       * .btn, now .btn-accent, and a superset of what this layout declared:
       * `font-weight` and the `background-color` transition came from
       * account.stx's copy of the same button. All nine call sites here
       * already wrote `font-semibold`, so the weight is unchanged; the
       * transition means the hover eases rather than snapping.
       */
      '.btn-accent { background-color: var(--accent); color: var(--accent-ink); border-radius: 10px; font-weight: 600; transition: transform 0.12s ease,opacity 0.15s ease,background-color 0.15s ease; }',
      '.btn-accent:hover { background-color: color-mix(in srgb,var(--accent) 88%,#000); }',
      '.btn-accent:active { transform: translateY(1px); }',
      '.btn-accent:disabled { opacity: 0.6; cursor: default; }',
      // .err / .ok
      '.err { background-color: color-mix(in srgb,var(--danger) 12%,transparent); color: var(--danger); }',
      '.ok { background-color: color-mix(in srgb,var(--accent) 12%,transparent); color: var(--accent); }',
      // .oauth-btn
      '.oauth-btn { border-width: 1px; border-style: solid; border-color: var(--border); border-radius: 10px; color: var(--text); background-color: var(--panel, var(--surface)); transition: border-color 0.15s ease,transform 0.12s ease; }',
      '.oauth-btn:hover { border-color: color-mix(in srgb,var(--accent) 45%,var(--border)); }',
      '.oauth-btn:active { transform: translateY(1px); }',
      // .divider -- both pseudo-elements, not just the one
      '.divider { display: flex; align-items: center; gap: 0.75rem; color: var(--text-3); font-size: 12px; }',
      '.divider::before { content: \'\'; height: 1px; flex: 1 1 0%; background-color: var(--border); }',
      '.divider::after { content: \'\'; height: 1px; flex: 1 1 0%; background-color: var(--border); }',
    ]
    for (const rule of rules)
      expect({ rule, present: has(css, rule) }).toEqual({ rule, present: true })
  })

  test('the call sites keep the utilities the old rules composed with', async () => {
    const css = await generate(MARKUP)
    for (const decl of ['padding-left: 0.875rem', 'width: 100%', 'font-weight: 600', 'font-weight: 500'])
      expect({ decl, present: has(css, decl) }).toEqual({ decl, present: true })
  })

  test('.btn is left to public/marketing.css', async () => {
    /*
     * Both vehicles would have gone wrong here, in opposite directions: a
     * shortcut named `btn` is unlayered and the generated sheet is linked
     * AFTER /marketing.css, so it would have repainted all 20 marketing views'
     * buttons; a preflight named `btn` would have lost to that file there and
     * still collided with account.stx's and visitor.stx's own `.btn`.
     */
    const css = await generate('<button class="btn primary">Go</button>')
    expect(css).not.toMatch(/\.btn\s*\{/)
    expect(css).not.toMatch(/\.btn[:\s]/)

    // And no auth view still asks for it.
    for (const view of ['login', 'register', 'forgot-password', 'reset-password', 'sites/new']) {
      const classes = [...read(`resources/views/${view}.stx`).matchAll(/class="([^"]*)"/g)]
        .flatMap(m => m[1].split(/\s+/))
      expect(`${view}: ${classes.includes('btn')}`).toBe(`${view}: false`)
    }
  })
})
