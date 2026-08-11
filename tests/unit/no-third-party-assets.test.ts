/**
 * No third party may be embedded in a page we serve.
 *
 * The marketing site loaded Geist from fonts.googleapis.com, so every visitor to
 * every page — /login included — announced themselves to Google (IP, User-Agent,
 * Referer) before any of our own content rendered. That is awkward anywhere; on
 * the site whose /compare/google-analytics page tells the reader GA "hands your
 * data to Google" while ours goes "into your own PostgreSQL database, and nowhere
 * else", it made the pitch untrue on the page making it. It is also the exact
 * arrangement LG München I held unlawful under GDPR in 2022 (3 O 17493/20).
 *
 * This is a regression guard, not a one-time cleanup. The failure mode is quiet:
 * a font, an icon set or an analytics snippet pasted into a layout looks fine in
 * review and in the browser, and nothing surfaces the outbound request. So the
 * check is on the source, and it covers every view rather than the handful that
 * happened to have one.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with comments removed.
 *
 * A file that explains why it no longer loads a host has to name that host, and
 * matching the name is not the same as making the request — public/fonts.css
 * documents the Google Fonts removal in its own header and would otherwise fail
 * the check it exists to enforce. This is the same false positive stx's codemod
 * and strict-mode guard both had (stacksjs/stx#1905, #1911): match code, not prose.
 */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '')

/** Hosts that must never appear in anything we serve. */
const FORBIDDEN = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
  'www.google-analytics.com',
  'googletagmanager.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(stx|css|html)$/.test(e)) out.push(rel)
  }
  return out
}

describe('no third-party hosts are embedded in served pages', () => {
  // resources/emails is deliberately excluded: those are sent, not served, and a
  // mail client is a different threat model from a page we render.
  const files = [...walk('resources/views'), ...walk('resources/layouts'), ...walk('resources/partials'), ...walk('public')]

  test('there are files to check, so an empty sweep cannot pass', () => {
    // A glob that silently matches nothing reads as coverage. Guard the guard.
    expect(files.length).toBeGreaterThan(20)
  })

  for (const host of FORBIDDEN) {
    test(`no view, layout, partial or public asset references ${host}`, () => {
      const hits = files.filter(f => code(f).includes(host))
      expect(hits).toEqual([])
    })
  }

  test('config/ui.ts head links are all same-origin', () => {
    const ui = code('config/ui.ts')
    const block = ui.slice(ui.indexOf('link: ['), ui.indexOf(']', ui.indexOf('link: [')))
    expect(block).not.toMatch(/href:\s*['"]https?:\/\//)
  })
})

describe('the fonts that replaced Google are actually present', () => {
  // Removing the Google link without shipping the files would "pass" the checks
  // above while silently dropping the site to a fallback face.
  const css = read('public/fonts.css')

  test('every @font-face src resolves to a file that exists', () => {
    const srcs = [...css.matchAll(/url\('([^']+)'\)/g)].map(m => m[1])
    expect(srcs.length).toBe(4)
    for (const src of srcs)
      expect(statSync(join(ROOT, 'public', src)).size).toBeGreaterThan(1000)
  })

  test('both families are declared across the weight range the site uses', () => {
    expect(css).toContain('font-family: \'Geist\'')
    expect(css).toContain('font-family: \'Geist Mono\'')
    expect(css).toContain('font-weight: 400 800')
    expect(css).toContain('font-weight: 400 600')
  })

  test('the stylesheet is linked from the head that reaches all views', () => {
    expect(read('config/ui.ts')).toContain('/fonts.css')
  })
})
