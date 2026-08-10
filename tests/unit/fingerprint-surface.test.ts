/**
 * Fingerprint surface (issue #10).
 *
 * The tracker used to send `document.title` and `screen.width`/`screen.height`
 * on every page view, and the ingest stored all three. Nothing ever read them:
 * every SELECT in routes/analytics.ts is column-explicit and none names them,
 * and `device_type` is derived from the User-Agent rather than from screen size.
 *
 * So they were collected, retained and never used — the weakest possible
 * position for a product whose comparison pages claim to hold no personal data.
 * A page title in particular routinely carries page content, which on a real app
 * means names, invoice numbers and email addresses.
 *
 * These tests pin the removal. They are deliberately source-level: the point is
 * that the fields never leave the browser, which is upstream of any behaviour a
 * request-level test could observe.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const tracker = readFileSync(join(ROOT, 'public/script.js'), 'utf8')
const routes = readFileSync(join(ROOT, 'routes/analytics.ts'), 'utf8')
const model = readFileSync(join(ROOT, 'app/Models/PageView.ts'), 'utf8')

/** Strip comments — every one of these fields is *named* in a comment explaining its removal. */
function code(src: string): string {
  return src
    .replace(/\{\{--[\s\S]*?--\}\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the tracker does not collect a fingerprint surface (#10)', () => {
  test('screen dimensions are never read from the browser', () => {
    expect(code(tracker)).not.toContain('screen.width')
    expect(code(tracker)).not.toContain('screen.height')
  })

  test('the page title is never read from the browser', () => {
    expect(code(tracker)).not.toContain('d.title')
    expect(code(tracker)).not.toContain('document.title')
  })

  test('the beacon body carries neither field', () => {
    // The wire keys, as the ingest names them.
    const body = code(tracker).slice(code(tracker).indexOf('const b = {'))
    const decl = body.slice(0, body.indexOf('}'))
    for (const key of ['t:', 'sw:', 'sh:'])
      expect(decl).not.toContain(key)
  })

  test('what the tracker still sends is unchanged', () => {
    // Guard against over-deletion: the fields the reports actually use must survive.
    const decl = code(tracker).slice(code(tracker).indexOf('const b = {'))
    for (const key of ['s:', 'e:', 'p:', 'u:', 'r:'])
      expect(decl).toContain(key)
  })
})

describe('the ingest does not store them (#10)', () => {
  test('the page_views insert names none of the three columns', () => {
    const c = code(routes)
    expect(c).not.toContain('screen_width')
    expect(c).not.toContain('screen_height')
    expect(c).not.toMatch(/\btitle:\s/)
  })

  test('the model no longer declares them fillable', () => {
    const c = code(model)
    expect(c).not.toContain('screen_width')
    expect(c).not.toContain('screen_height')
  })

  test('a migration drops the columns, so historical data goes too', () => {
    // Stopping collection is only half of it — the already-collected rows are
    // the liability that motivated this.
    const sql = readFileSync(
      join(ROOT, 'database/migrations/0000000037-drop-fingerprint-columns-from-page_views.sql'),
      'utf8',
    )
    for (const col of ['title', 'screen_width', 'screen_height'])
      expect(sql).toContain(`DROP COLUMN IF EXISTS "${col}"`)
  })
})
