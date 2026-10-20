/**
 * A control that is working has to SAY it is working.
 *
 * Every async button in this app gates itself on a busy signal through
 * `:disabled`, which stops a second click and greys the control. For a screen
 * reader that is not the same thing: `disabled` removes the button from the
 * focus order, so someone who just activated it loses their place and hears
 * nothing about why. `aria-busy` is what announces "this control is working",
 * and nothing in this app emitted it before.
 *
 * `:aria-busy` rather than a label change on purpose. A reactive mustache in a
 * button's own text makes stx cloak the element until hydration, which is the
 * reason the import buttons in dashboard.stx carry STATIC labels and say so in
 * a comment. An attribute binding does not cloak, so this is additive: the
 * static label and the progress line below it are both untouched.
 *
 * The value lands as a string, not as bare presence. stx's attribute binding
 * special-cases `aria-*` (dist/signals.js: `attrName.startsWith('aria-') &&
 * typeof v === 'boolean'` writes `String(v)`), so a boolean signal emits
 * `aria-busy="true"` / `"false"` rather than the `aria-busy=""` that the
 * ordinary boolean path would write, and `aria-busy=""` reads as FALSE.
 *
 * The pairing with the signal matters as much as the attribute. `aria-busy`
 * means "this element is being updated", so a signal shared by two buttons
 * that are BOTH on screen cannot drive both: starting a check would announce
 * the import button as busy too. That is why dashboard.stx carries
 * `fathomAction`. Where the two buttons are mutually exclusive (the share
 * control's create/revoke pair, each inside its own `:show`) the shared signal
 * is unambiguous and is used directly.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const BUSY = /busy|loading|saving|sending|submitting|importing/i

function views(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try { directory = statSync(path).isDirectory() }
      catch { continue }
    }
    if (directory) out.push(...views(path))
    else if (entry.name.endsWith('.stx')) out.push(path)
  }
  return out
}

/** Open tags only, with quoted values kept whole so a `>` inside one cannot end the tag. */
const OPEN_TAG = /<button\b((?:[^>"]|"[^"]*")*)>/g

/**
 * Comments, all three kinds, because prose about a shape matches a grep for it.
 * The block comment above `fathomAction` says "beside every fathomBusy.set()",
 * and that sentence failed the mutation-count assertion below on the first run.
 */
function code(source: string): string {
  return source
    .replace(/\{\{--[\s\S]*?--\}\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function asyncButtons(source: string): { attrs: string, index: number }[] {
  const code_ = code(source)
  const found: { attrs: string, index: number }[] = []
  for (const match of code_.matchAll(OPEN_TAG)) {
    const attrs = match[1]
    const disabled = /:disabled="([^"]*)"/.exec(attrs)
    if (!disabled || !BUSY.test(disabled[1]))
      continue
    found.push({ attrs, index: match.index })
  }
  return found
}

describe('async buttons announce that they are working', () => {
  const files = views(join(ROOT, 'resources'))

  test('every button gated on a busy signal carries :aria-busy', () => {
    const missing: string[] = []
    for (const file of files) {
      for (const button of asyncButtons(readFileSync(file, 'utf8'))) {
        if (!/:aria-busy="/.test(button.attrs))
          missing.push(`${file.slice(ROOT.length + 1)}: ${button.attrs.trim().slice(0, 90)}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('the count does not quietly fall to zero', () => {
    const total = files.reduce((n, f) => n + asyncButtons(readFileSync(f, 'utf8')).length, 0)
    // 17 at the time of writing. A regex that stops matching would pass the
    // test above by finding nothing at all, which is the failure mode of every
    // gate in this repo that greps for a shape.
    expect(total).toBeGreaterThanOrEqual(17)
  })

  /*
   * Two pairs of buttons sit on screen together sharing one busy signal. The
   * signal is right for `:disabled` -- neither should be clickable while either
   * runs -- and wrong for `aria-busy`, which names ONE element as updating. Each
   * pair therefore has a discriminator saying which of the two is working.
   *
   * The share control's create/revoke pair is deliberately absent: those two are
   * mutually exclusive, each inside its own `:show`, so the shared signal cannot
   * be ambiguous and is used directly.
   */
  const PAIRS = [
    { what: 'Fathom', match: /fathom/i, busy: 'fathomBusy', action: 'fathomAction' },
    { what: 'read key', match: /ReadKey/, busy: 'readKeyBusy', action: 'readKeyAction' },
  ]

  for (const pair of PAIRS) {
    test(`the two ${pair.what} buttons do not share one aria-busy source`, () => {
      const dashboard = readFileSync(join(ROOT, 'resources/views/dashboard.stx'), 'utf8')
      const found = asyncButtons(dashboard).filter(b => pair.match.test(b.attrs))
      expect(found).toHaveLength(2)
      const sources = found.map(b => /:aria-busy="([^"]*)"/.exec(b.attrs)?.[1])
      expect(new Set(sources).size).toBe(2)
      for (const source of sources)
        expect(source).toContain(`${pair.action}()`)
    })

    test(`${pair.action} is cleared wherever ${pair.busy} is`, () => {
      // A discriminator left set after the work finishes announces a button as
      // busy forever, which is worse than not announcing it at all.
      const body = code(readFileSync(join(ROOT, 'resources/views/dashboard.stx'), 'utf8'))
      expect((body.match(new RegExp(`${pair.busy}\\.set\\(`, 'g')) ?? []).length)
        .toBe((body.match(new RegExp(`${pair.action}\\.set\\(`, 'g')) ?? []).length)
    })
  }
})
