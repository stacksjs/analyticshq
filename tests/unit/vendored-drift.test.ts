/**
 * The vendored framework tree is the code that runs. It must not drift.
 *
 * `frameworkPath()` resolves to `storage/framework/`, and both the generated
 * auto-import barrels and `defaults/bootstrap.ts` reach into that tree by
 * relative path. So `storage/framework/defaults` executes — not
 * `node_modules/@stacksjs/defaults`. Nothing refreshes it on its own: `bun
 * install` advances node_modules and leaves it alone, there is no postinstall,
 * and it is gitignored so a checkout never carries it. Left alone it pins the
 * app to whenever it was last written.
 *
 * ## Why this is a general test and not another incident-shaped one
 *
 * `password-reset-privacy.test.ts` exists because this already happened: the
 * vendored tree sat months behind while the shipped action was fixed, and
 * /password/forgot went on leaking whether an address had an account. That test
 * guards `app/Actions/Password`, which is the file that incident touched.
 *
 * It would not have caught the next one. When this file was written the same
 * tree was 122 files behind again, and among them were nine middleware —
 * Throttle, Can, Role, Permission, Team, Abilities, EnsureEmailIsVerified — the
 * code that decides who may do what and how often. None of that is in
 * `app/Actions/Password`.
 *
 * So the invariant is the whole tree, asserted once, rather than one directory
 * per incident.
 *
 * ## What to do when this fails
 *
 * Run what the deploy runs (config/cloud.ts preStart):
 *
 *     rm -rf storage/framework/defaults \
 *       && cp -R node_modules/@stacksjs/defaults storage/framework/defaults
 *     rm -rf storage/framework/auto-imports
 *
 * The second line is not optional. The barrels are generated AGAINST the tree
 * and re-export from it by relative path, so replacing defaults/ without
 * clearing them leaves a barrel pointing at modules the new tree no longer has.
 * The plugin rewrites them on next boot.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const PACKAGE = join(ROOT, 'node_modules/@stacksjs/defaults')
const VENDORED = join(ROOT, 'storage/framework/defaults')

/** Every file under a directory, as paths relative to it. */
function filesUnder(dir: string, base = dir, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const entry of readdirSync(dir)) {
    if (entry === '.gitkeep')
      continue
    const full = join(dir, entry)
    let s
    try { s = statSync(full) }
    catch { continue }
    if (s.isDirectory())
      filesUnder(full, base, out)
    else out.push(full.slice(base.length + 1))
  }
  return out
}

describe('the vendored framework tree matches the installed package', () => {
  // A fresh checkout has no vendored tree, and that is not drift — the deploy
  // re-vendors before boot. Only a tree that EXISTS can be stale.
  const vendoredExists = existsSync(VENDORED)
  const packaged = existsSync(PACKAGE) ? filesUnder(PACKAGE) : []

  test('the installed package is present to compare against', () => {
    // Guard the guard: if this vanished, every comparison below passes vacuously.
    expect(existsSync(PACKAGE)).toBe(true)
    expect(packaged.length).toBeGreaterThan(1000)
  })

  test.if(vendoredExists)('every packaged file is present in the vendored tree', () => {
    // `cp -R` after `rm -rf` rather than an overlay, so a file DELETED upstream
    // does not linger and keep resolving. The inverse — vendored files with no
    // packaged counterpart — is the same failure and is caught here as a missing
    // file on the next re-vendor.
    const missing = packaged.filter(f => !existsSync(join(VENDORED, f)))
    expect({ count: missing.length, sample: missing.slice(0, 5) }).toEqual({ count: 0, sample: [] })
  })

  test.if(vendoredExists)('no vendored file differs from its packaged original', () => {
    // Byte for byte, over the whole tree. Reporting a count and a sample rather
    // than failing on the first mismatch: "122 files behind, here are five" is
    // the diagnosis, and one filename is not.
    const differing: string[] = []
    for (const f of packaged) {
      const v = join(VENDORED, f)
      if (!existsSync(v))
        continue
      try {
        if (readFileSync(join(PACKAGE, f), 'utf8') !== readFileSync(v, 'utf8'))
          differing.push(f)
      }
      catch {
        // Unreadable on either side counts as drift rather than being skipped.
        differing.push(f)
      }
    }
    expect({ count: differing.length, sample: differing.slice(0, 5) }).toEqual({ count: 0, sample: [] })
  })

  test.if(vendoredExists)('the middleware that decides authorization is current', () => {
    // Redundant with the sweep above, and kept anyway: these are the files whose
    // staleness is a security bug rather than a cosmetic one, and naming them
    // means a failure says WHICH invariant broke rather than "122 files differ".
    const rel = 'app/Middleware'
    const names = filesUnder(join(PACKAGE, rel))
    expect(names.length).toBeGreaterThan(10)
    for (const file of names) {
      const a = readFileSync(join(PACKAGE, rel, file), 'utf8')
      const b = existsSync(join(VENDORED, rel, file)) ? readFileSync(join(VENDORED, rel, file), 'utf8') : ''
      expect({ file, matches: a === b }).toEqual({ file, matches: true })
    }
  })
})

describe('the ORM route generator cannot shadow a guarded route', () => {
  /**
   * `defaults/bootstrap.ts` does `await import(frameworkPath('orm/routes.ts'))`,
   * so `storage/framework/orm/routes.ts` executes — and unlike `defaults`,
   * NOTHING refreshes it. The deploy re-vendors defaults only, and
   * `@stacksjs/orm` ships `dist/routes.js` with no `routes.ts` for a re-vendor
   * to copy, so that file is orphaned at whatever version it was written.
   *
   * The copy in this app predates stacksjs/stacks#2364: its `routeExists`
   * compares literal paths, so `/api/sites/{siteId}` did not match the generated
   * `/api/sites/{id}` and the generator registered over a route that already
   * existed — silently replacing a role-checked handler with an unguarded one.
   *
   * We are not exposed because no model declares `useApi` (asserted in
   * api-authz.test.ts), which leaves the generator with nothing to generate.
   * This test ties the two together: if that stops being true while the stale
   * generator is still what boots, the shadowing comes back.
   */
  const ormRoutes = join(ROOT, 'storage/framework/orm/routes.ts')

  test.if(existsSync(ormRoutes))('either the generator is current, or it has nothing to generate', () => {
    const src = readFileSync(ormRoutes, 'utf8')
    // The fixed generator collapses `{siteId}` and `{id}` to one shape before
    // comparing. Its absence is the tell for the version that shadows.
    const guardIsCurrent = src.includes('routeShape')

    const modelsDir = join(ROOT, 'app/Models')
    const anyModelGenerates = readdirSync(modelsDir)
      .filter(f => f.endsWith('.ts'))
      .some(f => /\buseApi\b/.test(
        readFileSync(join(modelsDir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, ''),
      ))

    expect({ guardIsCurrent, anyModelGenerates })
      .toEqual({ guardIsCurrent, anyModelGenerates: guardIsCurrent ? anyModelGenerates : false })
  })
})
