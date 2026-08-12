/**
 * Does the suite still see every test we wrote?
 *
 * `bunfig.toml` sets `[test] root = "tests"`, because `storage/framework/` is a
 * gitignored copy of the @stacksjs defaults package and ships its own *.test.ts
 * files — a bare `bun test` ran 88 files instead of 13 and went red on a stale
 * assertion in the framework's tax-rate tests, which is not ours to fix.
 *
 * That fix buys a footgun: `root` does not warn about tests outside it, it just
 * never runs them. A co-located `app/Analytics/access.test.ts` would report
 * nothing, pass CI, and look exactly like a suite that has no such test. So the
 * narrowing is checked here rather than trusted.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../..')

/** Trees that are not ours: dependencies, vendored framework, build output. */
const PRUNE = new Set(['node_modules', 'storage', '.git', 'dist', '.stacks', 'public', 'coverage'])

function findTests(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!PRUNE.has(entry.name) && !entry.name.startsWith('.'))
        findTests(join(dir, entry.name), found)
    }
    else if (/\.(?:test|spec)\.ts$/.test(entry.name)) {
      found.push(relative(ROOT, join(dir, entry.name)))
    }
  }
  return found
}

describe('test discovery', () => {
  test('every test we own lives under tests/, where the runner looks', () => {
    const stray = findTests(ROOT).filter(p => !p.startsWith('tests/'))

    // Not a style rule. A file listed here is one bun silently does not run.
    expect(stray, `these tests are outside \`[test] root\` and will never run — move them under tests/ or widen the root in bunfig.toml:\n  ${stray.join('\n  ')}`).toEqual([])
  })

  test('and the suite is finding a plausible number of them', () => {
    // Guards the other direction: a root typo, or a prune rule that swallows
    // tests/, would leave bun reporting a cheerful green zero.
    expect(findTests(join(ROOT, 'tests')).length).toBeGreaterThan(10)
  })
})
