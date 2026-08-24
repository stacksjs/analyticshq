/**
 * An stx comment must not terminate before its author intended.
 *
 * resources/layouts/marketing.stx documented the comment syntax by writing an
 * example of it *inside* a comment. stx's stripper is non-nesting — it cuts from
 * the opening delimiter to the FIRST closing one — so the comment ended at the
 * example, and the remaining six lines of prose rendered as visible text at the
 * top of analyticshq.org, above the nav, on every marketing page. It shipped and
 * sat there in production.
 *
 * Nothing catches this. It is not a syntax error: the file compiles, the page
 * returns 200, the layout is otherwise intact, and every other view on the site
 * is unaffected. Grep cannot see it either — the source looks like one ordinary
 * comment, and both delimiters are present and balanced by eye. It is only
 * visible in the rendered output, which is why it survived review.
 *
 * So the check is on the source, and it models what the stripper actually does
 * rather than what the delimiters look like.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')

/** Assembled rather than written literally, so this file cannot trip its own check. */
const OPEN = `{{${'--'}`
const CLOSE = `${'--'}}}`

/**
 * The source as stx leaves it, using stx's own non-greedy rule.
 *
 * The lazy quantifier is the bug being guarded, not an approximation of it: a
 * greedy match here would model a stripper that nests, pass the file that broke
 * production, and make the test worthless.
 */
const stripComments = (src: string) => src.replace(/\{\{--[\s\S]*?--\}\}/g, '')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === 'node_modules' || e === '.git' || e === 'dist')
      continue
    const rel = `${dir}/${e}`
    if (statSync(join(ROOT, rel)).isDirectory())
      walk(rel, out)
    else if (e.endsWith('.stx'))
      out.push(rel)
  }
  return out
}

describe('no stx comment leaks into the rendered page', () => {
  const files = walk('resources')

  test('there are files to check, so an empty sweep cannot pass', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  for (const f of files) {
    test(`${f} has no delimiter left after stripping`, () => {
      const left = stripComments(readFileSync(join(ROOT, f), 'utf8'))

      // A surviving closing delimiter means a comment ended early and the prose
      // after it is now page content. A surviving opening delimiter means a
      // comment was never closed, which swallows the markup that follows it.
      const remnant = left.includes(CLOSE) ? CLOSE : left.includes(OPEN) ? OPEN : ''
      const context = remnant
        ? left.slice(Math.max(0, left.indexOf(remnant) - 90), left.indexOf(remnant) + remnant.length).replace(/\s+/g, ' ')
        : ''

      expect({ file: f, remnant, context }).toEqual({ file: f, remnant: '', context: '' })
    })
  }
})

describe('the layout that broke production', () => {
  const src = readFileSync(join(ROOT, 'resources/layouts/marketing.stx'), 'utf8')

  test('its header comment is stripped in full', () => {
    // The specific prose that was visible above the nav on analyticshq.org.
    const rendered = stripComments(src)
    expect(rendered).not.toContain('re-parsed by four separate')
    expect(rendered).not.toContain("the router's layout group")
  })

  test('it still carries a header comment at all', () => {
    // The cheapest way to pass the check above is to delete the documentation.
    // These lines are the reason nobody has re-added a DOCTYPE to this file.
    expect(src.startsWith(OPEN)).toBe(true)
    expect(src).toContain('This file is a FRAGMENT, not a document')
  })

  test('it warns the next author about the trap', () => {
    expect(src).toContain('non-nesting')
  })
})
