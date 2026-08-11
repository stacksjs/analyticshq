/**
 * /password/forgot must not reveal whether an account exists (#34).
 *
 * Measured against the running API, the endpoint used to answer:
 *
 *   known address    -> 500 "Failed to send password reset email. Please try again later."
 *   unknown address  -> 404 "No account found with this email address."
 *
 * and now answers 200 with one identical body for both. It is unauthenticated
 * and takes an arbitrary address, so any observable difference between the two
 * is a membership test against the whole user table.
 *
 * ## What is actually being guarded here
 *
 * The fix is not in this repo's source. It shipped in the framework
 * (stacksjs/stacks#2214), and the app runs it — so there is no app-level file to
 * assert on, and duplicating one would only mean the app stops receiving
 * upstream fixes to this endpoint.
 *
 * What went wrong was never the action's logic; it was WHICH COPY ran.
 * `defaultsAppPath()` resolves to `storage/framework/defaults`, and the
 * generated auto-import barrels reach into it by relative path, so that vendored
 * tree is the code that executes. Nothing refreshes it: `bun install` advances
 * `node_modules/@stacksjs/defaults` and leaves it alone, there is no postinstall,
 * and it is gitignored so a checkout never carries it. It sat at 2026-07-23 while
 * the installed package moved on, and the app quietly served a months-old
 * password endpoint.
 *
 * So the invariant worth testing is the drift itself, which generalises past this
 * one action: if a vendored copy exists, it must match the installed package.
 * That is what stacksjs/stacks#2303 detects upstream; this fails the build
 * locally, and `config/cloud.ts` re-vendors on every deploy.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
    if (statSync(full).isDirectory())
      filesUnder(full, base, out)
    else out.push(full.slice(base.length + 1))
  }
  return out
}

describe('the vendored framework copy is the one that runs, so it must not drift', () => {
  // A fresh checkout has no vendored tree at all, and that is not drift — the
  // deploy re-vendors before boot. Only a tree that EXISTS can be stale.
  const vendoredExists = existsSync(VENDORED)

  test('the installed package is present to compare against', () => {
    // Guard the guard: if this directory vanished, every comparison below would
    // pass vacuously.
    expect(existsSync(PACKAGE)).toBe(true)
    expect(filesUnder(join(PACKAGE, 'app/Actions')).length).toBeGreaterThan(50)
  })

  test.if(vendoredExists)('the password actions match the installed package byte for byte', () => {
    // Scoped to the actions behind the auth endpoints rather than all 11 MB:
    // these are the ones whose staleness is a security bug rather than a
    // cosmetic one.
    const rel = 'app/Actions/Password'
    for (const file of filesUnder(join(PACKAGE, rel))) {
      const a = readFileSync(join(PACKAGE, rel, file), 'utf8')
      const b = existsSync(join(VENDORED, rel, file)) ? readFileSync(join(VENDORED, rel, file), 'utf8') : ''
      expect({ file, matches: a === b }).toEqual({ file, matches: true })
    }
  })

  test.if(vendoredExists)('the vendored tree carries the enumeration fix, not the leaky version', () => {
    // Named strings rather than a version number, because a version number can
    // be right while the file is not. These are the actual tells.
    const action = join(VENDORED, 'app/Actions/Password/SendPasswordResetEmailAction.ts')
    expect(existsSync(action)).toBe(true)
    // Comments stripped first: the FIXED action documents what it removed, so it
    // quotes `404 "No account found with this email address."` in a comment and
    // would fail a raw substring check. Same prose-vs-code false positive as
    // stacksjs/stx#1905 and #1911 — match code, not the explanation of the code.
    const src = readFileSync(action, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).toContain('NEUTRAL_RESPONSE')
    expect(src).not.toContain('No account found with this email address')
    expect(src).not.toContain('Failed to send password reset email')
  })
})

describe('deploy re-vendors, so a box cannot boot on a stale copy', () => {
  const cloud = readFileSync(join(ROOT, 'config/cloud.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  test('both sites re-copy the defaults after installing', () => {
    // `main` builds the server and `api` runs the Actions — the API site is the
    // one actually serving /password/forgot, so a sync on only one is a trap.
    const syncs = [...cloud.matchAll(/cp -R node_modules\/@stacksjs\/defaults storage\/framework\/defaults/g)]
    expect(syncs.length).toBe(2)
  })

  test('the copy is exact rather than an overlay', () => {
    // Without the rm, files deleted upstream linger in the vendored tree and go
    // on resolving. 121 such files had accumulated.
    expect(cloud).toMatch(/rm -rf storage\/framework\/defaults\s*&&/)
  })
})
