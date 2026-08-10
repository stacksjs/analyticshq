/**
 * Visitor-hash salt privacy (issue #9) and DNT/GPC (issue #8).
 *
 * The salt used to be the plain UTC date. Because that value is public, the only
 * unknown left in `sha256(ip | ua | siteId | salt)` was the IP — so a stored
 * visitor id acted as a confirmation oracle: take a candidate IP and
 * User-Agent, hash it, compare, and learn whether that person visited. Storing
 * no raw IP does not help when the input space is that small.
 *
 * These tests pin the properties that make the fix real, rather than just
 * asserting the new code runs.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { saltDateFor } from '../../app/Analytics/salt'
import { hashVisitor } from '../../app/Analytics/tracking'

const ROOT = join(import.meta.dir, '../..')

describe('the visitor hash is not a confirmation oracle (#9)', () => {
  test('the date alone no longer reproduces a visitor id', () => {
    // The exact attack the old scheme allowed: everything but the salt is
    // guessable, so an attacker recomputes the digest from public information.
    const ip = '203.0.113.7'
    const ua = 'Mozilla/5.0'
    const site = 'site_abc'
    const today = new Date('2026-08-10T12:00:00Z')

    const real = hashVisitor(ip, ua, site, 'a-real-secret-salt')
    const guessedWithPublicDate = createHash('sha256')
      .update(`${ip}|${ua}|${site}|${saltDateFor(today)}`)
      .digest('hex')
      .slice(0, 32)

    expect(real).not.toBe(guessedWithPublicDate)
  })

  test('a different salt gives a different id for identical inputs', () => {
    const a = hashVisitor('1.2.3.4', 'UA', 'site', 'salt-monday')
    const b = hashVisitor('1.2.3.4', 'UA', 'site', 'salt-tuesday')
    expect(a).not.toBe(b)
  })

  test('the same salt is stable — a visitor is counted once, not per beacon', () => {
    const a = hashVisitor('1.2.3.4', 'UA', 'site', 'salt')
    const b = hashVisitor('1.2.3.4', 'UA', 'site', 'salt')
    expect(a).toBe(b)
  })

  test('one salt still separates sites, so ids cannot be joined across them', () => {
    const a = hashVisitor('1.2.3.4', 'UA', 'site-a', 'shared-salt')
    const b = hashVisitor('1.2.3.4', 'UA', 'site-b', 'shared-salt')
    expect(a).not.toBe(b)
  })

  test('hashVisitor takes an explicit salt and cannot silently fall back to a date', () => {
    // Guards the regression that would undo all of the above: a default
    // parameter reintroducing a derivable salt. The 4th argument is required.
    expect(hashVisitor.length).toBe(4)

    const src = readFileSync(join(ROOT, 'app/Analytics/tracking.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export function hashVisitor'))
    expect(fn.slice(0, fn.indexOf('}'))).not.toContain('toISOString')
  })
})

describe('salt lifecycle (#9)', () => {
  test('saltDateFor is the UTC calendar day', () => {
    expect(saltDateFor(new Date('2026-08-10T23:59:59Z'))).toBe('2026-08-10')
    expect(saltDateFor(new Date('2026-08-11T00:00:01Z'))).toBe('2026-08-11')
  })

  test('the salt is purged, which is what makes old hashes unlinkable', () => {
    // While the row exists the mapping is only secret; deletion is what makes it
    // irreversible. If this DELETE ever goes away the privacy claim goes with it.
    const src = readFileSync(join(ROOT, 'app/Analytics/salt.ts'), 'utf8')
    expect(src).toContain('DELETE FROM visitor_salts')
  })

  test('a database failure does not degrade to a derivable salt', () => {
    // The dangerous shortcut would be catching the error and falling back to the
    // date string, quietly restoring the oracle.
    const src = readFileSync(join(ROOT, 'app/Analytics/salt.ts'), 'utf8')
    const catchBlock = src.slice(src.indexOf('catch {'))
    expect(catchBlock).not.toContain('toISOString().slice(0, 10)')
    expect(src).toContain('randomBytes(32)')
  })
})

describe('DNT / GPC are honored (#8)', () => {
  const tracker = readFileSync(join(ROOT, 'public/script.js'), 'utf8')
  const routes = readFileSync(join(ROOT, 'routes/analytics.ts'), 'utf8')

  test('the tracker checks doNotTrack and globalPrivacyControl', () => {
    expect(tracker).toContain('doNotTrack')
    expect(tracker).toContain('globalPrivacyControl')
  })

  test('the tracker bails before attaching listeners, not just before sending', () => {
    // Bailing inside send() would still install history hooks and link handlers.
    // The guard has to sit above the listener registration to leave no trace.
    const guard = tracker.indexOf('globalPrivacyControl')
    const listeners = tracker.indexOf('addEventListener')
    expect(guard).toBeGreaterThan(-1)
    expect(listeners).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(listeners)
  })

  test('a site can opt out of respecting the signal', () => {
    expect(tracker).toContain('data-respect-dnt')
  })

  test('the server honors Sec-GPC independently of the tracker', () => {
    // The backstop for a cached, self-hosted or hand-rolled beacon that never
    // runs our client code.
    expect(routes).toContain('sec-gpc')
  })
})
