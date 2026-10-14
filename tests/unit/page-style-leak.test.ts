/**
 * A page's CSS must live inside the router's container.
 *
 * The SPA router removes `style[data-crosswind]` and `style[data-stx-page]` and
 * nothing else. `<main>` is the container: a <style> inside it is part of the
 * swapped fragment and lives exactly as long as the page does. A <style>
 * anywhere else survives every navigation for the rest of the session.
 *
 * All three layouts rendered `@stack('styles')` inside `@head` until
 * 2026-10-13, and four views push to it -- dashboard, visitor and account on
 * the app layout, pricing on the marketing one. Measured on the served pages
 * rather than inferred: entering on /pricing and clicking to / left its
 * 2,475-char block live, and a fresh `<div class="price-toggle">` appended to
 * the home page computed `display: inline-flex; border-radius: 999px` from a
 * rule that page never declared. Entering on /dashboard did the same with
 * 23,664 chars, including a `.panel` and a `.btn` that eight and six other
 * files use in markup.
 *
 * Pushing is still the right thing for a page to do -- once a layout applies,
 * stx sweeps every orphan <style> out of the page and appends it after the
 * content -- so the fix belongs in the layouts, and so does this test.
 *
 * The layouts' OWN <style> blocks used to stay in `@head`, and the argument
 * for that was sound as far as it went: the :root token block in app.stx and
 * auth.stx belongs to every page those layouts serve, by design rather than by
 * accident of entry. But "belongs to every page" is the definition of a
 * preflight, and a <style> block in a .stx file is what rule 3 / §11.1
 * forbids, so both are config/crosswind.ts entries now -- scoped to their
 * layout group, and inside the one tag the router already preserves. See
 * tests/unit/layout-chrome-css.test.ts. Nothing below changes: this file is
 * about where a PAGE's styles are rendered, and four views still push.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const LAYOUTS = ['marketing', 'app', 'auth']

/*
 * Comments are blanked rather than removed, so every offset below still points
 * at the same character of the real file. These layouts document their own
 * structure at length -- app.stx says "<main> lives HERE" and names
 * `@stack('styles')` in prose -- and reading those as markup put `<main>` 3kB
 * before the real one and found the stack in a sentence about the stack.
 */
function layout(name: string): string {
  const src = readFileSync(join(ROOT, `resources/layouts/${name}.stx`), 'utf8')
  return src.replace(/\{\{--[\s\S]*?--\}\}/g, m => ' '.repeat(m.length))
}

describe('page style leak', () => {
  test('every layout renders the styles stack inside <main>', () => {
    for (const name of LAYOUTS) {
      const src = layout(name)
      const stack = src.indexOf('@stack(\'styles\')')
      if (stack < 0)
        continue
      const open = src.indexOf('<main')
      const close = src.lastIndexOf('</main>')
      expect(`${name}: has <main>`).toBe(`${name}: ${open >= 0 && close > open ? 'has <main>' : 'MISSING'}`)
      expect(`${name}: ${stack > open && stack < close}`).toBe(`${name}: true`)
    }
  })

  test('no layout renders the styles stack inside @head', () => {
    for (const name of LAYOUTS) {
      const src = layout(name)
      const head = src.indexOf('@head')
      const endhead = src.indexOf('@endhead')
      const stack = src.indexOf('@stack(\'styles\')')
      if (stack < 0 || head < 0)
        continue
      expect(`${name}: ${stack > head && stack < endhead}`).toBe(`${name}: false`)
    }
  })

  test('the four pushing views still push rather than leaving a <style> loose', () => {
    // Not cosmetic: a loose <style> is swept out of the page and appended after
    // the content by stx, which puts it outside <main> again. The push is what
    // keeps it where the layout decides.
    for (const view of ['dashboard', 'visitor', 'pricing', 'account']) {
      const src = readFileSync(join(ROOT, `resources/views/${view}.stx`), 'utf8')
      const pushed = /@push\(['"]styles['"]\)([\s\S]*?)@endpush/.exec(src)
      expect(`${view}: pushes`).toBe(`${view}: ${pushed && /<style/.test(pushed[1]) ? 'pushes' : 'LOOSE OR MISSING'}`)
      const outside = src.replace(/@push\(['"]styles['"]\)[\s\S]*?@endpush/g, '')
      expect(`${view}: ${/<style/.test(outside)}`).toBe(`${view}: false`)
    }
  })
})
