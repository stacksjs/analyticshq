import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const marketing = readFileSync(join(ROOT, 'public/marketing.css'), 'utf8')

// The phone menu lists every marketing destination in one column, which is
// taller than an 812px viewport. The panel has to scroll inside the viewport
// and the page behind it has to stay put, or the last links are unreachable.
describe('mobile layout contracts', () => {
  test('marketing menu is bounded by the visible mobile viewport', () => {
    const panel = marketing.match(/\.nav-menu-panel\s*\{[^}]*\}/)?.[0] ?? ''
    expect(panel).toContain('max-height: calc(100dvh - 92px)')
    expect(panel).toContain('overflow-y: auto')
    expect(panel).toContain('overscroll-behavior: contain')
  })

  test('opening the marketing menu locks the page behind it', () => {
    expect(marketing).toContain('body:has(.nav-menu[open]) { overflow: hidden; }')
  })
})
