/**
 * An invitation is a bearer credential that arrives by email and sits in a
 * mailbox. Mailboxes are forwarded, breached and inherited, so the rules around
 * one are worth pinning down rather than trusting to a reading of the route.
 *
 * The DB-backed half is not mocked here, for the reason site-access.test.ts
 * gives: mocking it would only prove the mock. What is asserted instead is the
 * decision logic, plus source-level guarantees about the endpoints that carry it
 * — the same shape as api-authz.test.ts, which exists because a route once lost
 * its guard and nothing noticed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  expiryFrom,
  hashesMatch,
  hashToken,
  INVITE_TTL_HOURS,
  inviteRefusal,
  looksLikeEmail,
  mintToken,
  normalizeEmail,
} from '../../app/Analytics/invites'

const ROOT = join(import.meta.dir, '../..')
const routes = readFileSync(join(ROOT, 'routes/analytics.ts'), 'utf8')

/**
 * The source of one route declaration, bounded by the NEXT one.
 *
 * Not a fixed character window. api-authz.test.ts records what those cost: an
 * `i + 900` slice silently stopped covering `.middleware('auth')` as the handler
 * grew, and the test kept passing. A window that overruns is the same bug in the
 * other direction — it reads the next route's strings as if they were this one's,
 * which is exactly what the first draft of this file did.
 */
function routeBlock(marker: string): string {
  const start = routes.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const next = routes.indexOf('\nroute.', start + marker.length)
  return routes.slice(start, next === -1 ? routes.length : next)
}

describe('tokens', () => {
  test('are unguessably long and never repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintToken()))
    expect(seen.size).toBe(200)
    for (const t of seen)
      expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  test('hash to something that is not the token', () => {
    // The whole point: what lands in the database must not be redeemable. A
    // dump, a backup or a log line would otherwise hand out standing access.
    const token = mintToken()
    const digest = hashToken(token)
    expect(digest).not.toBe(token)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('hash deterministically, so lookup by hash works', () => {
    const token = mintToken()
    expect(hashToken(token)).toBe(hashToken(token))
  })

  test('different tokens do not collide', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })
})

describe('hashesMatch', () => {
  test('accepts equal values and rejects different ones', () => {
    expect(hashesMatch('abc', 'abc')).toBe(true)
    expect(hashesMatch('abc', 'abd')).toBe(false)
  })

  test('rejects anything that is not a non-empty string', () => {
    // timingSafeEqual throws on a length mismatch and on non-buffers. Returning
    // false rather than throwing keeps a malformed request a 404 instead of a 500.
    for (const bad of [null, undefined, '', 0, {}, [], true])
      expect(hashesMatch(bad, 'abc')).toBe(false)
    expect(hashesMatch('abc', '')).toBe(false)
  })

  test('compares values of different lengths without throwing', () => {
    // Both sides are re-hashed to a fixed width first. Catching a length error
    // instead would itself be a length oracle.
    expect(() => hashesMatch('short', 'a'.repeat(500))).not.toThrow()
    expect(hashesMatch('short', 'a'.repeat(500))).toBe(false)
  })
})

describe('addresses', () => {
  test('normalize to one comparable form', () => {
    // The invite and the redeeming account both pass through this, so a mismatch
    // can only mean a genuinely different address rather than different casing.
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com')
    expect(normalizeEmail(null)).toBe('')
    expect(normalizeEmail(undefined)).toBe('')
  })

  test('are validated permissively but not vacuously', () => {
    expect(looksLikeEmail('a@b.co')).toBe(true)
    expect(looksLikeEmail('first.last+tag@sub.example.com')).toBe(true)
    for (const bad of ['', '   ', 'not-an-email', 'a@b', '@example.com', 'a b@example.com', null, undefined])
      expect(looksLikeEmail(bad)).toBe(false)
  })

  test('rejects an address too long for the column', () => {
    // email is varchar(255); a longer one would be a database error rather than
    // a 400.
    expect(looksLikeEmail(`${'a'.repeat(250)}@example.com`)).toBe(false)
  })
})

describe('expiry', () => {
  test('is a fortnight by default', () => {
    expect(INVITE_TTL_HOURS).toBe(14 * 24)
  })

  test('is computed forward from now', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(expiryFrom(now, 24)).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('inviteRefusal', () => {
  const live = {
    email: 'invited@example.com',
    role: 'viewer',
    expires_at: '2030-01-01T00:00:00.000Z',
    accepted_at: null,
  }

  test('lets the invited address through', () => {
    expect(inviteRefusal(live, 'invited@example.com')).toBeNull()
  })

  test('is case and whitespace insensitive about the address', () => {
    expect(inviteRefusal(live, '  Invited@Example.COM ')).toBeNull()
  })

  test('turns away an account that was not invited', () => {
    // Without this the link alone is the credential, and anyone it is forwarded
    // to joins the site with their own account.
    expect(inviteRefusal(live, 'someone.else@example.com')).toBe('wrong_account')
  })

  test('refuses a token that matched nothing', () => {
    expect(inviteRefusal(null, 'invited@example.com')).toBe('not_found')
    expect(inviteRefusal(undefined, 'invited@example.com')).toBe('not_found')
  })

  test('refuses one that has already been redeemed', () => {
    // Single use. A forwarded thread must not be replayable.
    expect(inviteRefusal({ ...live, accepted_at: '2026-01-01T00:00:00.000Z' }, 'invited@example.com'))
      .toBe('already_accepted')
  })

  test('refuses an expired one', () => {
    const stale = { ...live, expires_at: '2020-01-01T00:00:00.000Z' }
    expect(inviteRefusal(stale, 'invited@example.com')).toBe('expired')
  })

  test('treats a missing or unparseable expiry as expired, not as forever', () => {
    // Failing open here would make every malformed row a permanent credential.
    expect(inviteRefusal({ ...live, expires_at: null }, 'invited@example.com')).toBe('expired')
    expect(inviteRefusal({ ...live, expires_at: 'whenever' }, 'invited@example.com')).toBe('expired')
  })

  test('checks expiry before identity', () => {
    // Otherwise the wrong holder can tell "live but not yours" from "dead",
    // which is a probe for whether an address has an open invitation.
    const stale = { ...live, expires_at: '2020-01-01T00:00:00.000Z' }
    expect(inviteRefusal(stale, 'someone.else@example.com')).toBe('expired')
  })

  test('expiry is evaluated against the clock it is given', () => {
    const before = new Date('2029-12-31T23:59:59.000Z')
    const after = new Date('2030-01-01T00:00:01.000Z')
    expect(inviteRefusal(live, 'invited@example.com', before)).toBeNull()
    expect(inviteRefusal(live, 'invited@example.com', after)).toBe('expired')
  })
})

describe('the endpoints that carry all this', () => {
  const createInvite = routeBlock(`route.post('/api/sites/{siteId}/invites'`)
  const acceptInvite = routeBlock(`route.post('/api/invites/accept'`)

  test('creating an invitation requires admin AND a paid plan', () => {
    expect(createInvite).toContain(`requireSiteRole(request, siteId, 'admin')`)
    expect(createInvite).toContain('requirePlanAllows(siteId, \'teammates\'')
    expect(createInvite).toContain(`.middleware('auth')`)
  })

  test('the role check comes before the plan check', () => {
    // An outsider must get 403 and learn nothing about the owner's billing; 402
    // would tell them the site exists and is on the free plan.
    expect(createInvite.indexOf('requireSiteRole')).toBeLessThan(createInvite.indexOf('requirePlanAllows'))
  })

  test('the direct-grant path is gated too', () => {
    // Otherwise the paywall is a formality: the same access, one endpoint over.
    expect(routeBlock(`route.post('/api/sites/{siteId}/members'`))
      .toContain('requirePlanAllows(siteId, \'teammates\'')
  })

  test('redemption requires an authenticated caller', () => {
    // The rule that keeps this from being an account-creation path: it grants
    // access to an identity that already exists, and never mints one.
    expect(acceptInvite).toContain('authUserId(request)')
    expect(acceptInvite).toContain('inviteRefusal(')
    expect(acceptInvite).toContain(`.middleware('auth')`)
  })

  test('redemption never creates a user', () => {
    expect(acceptInvite).not.toContain('INSERT INTO users')
    expect(acceptInvite).not.toMatch(/\bregister\s*\(/)
  })

  test('the invite is looked up by hash, never by the raw token', () => {
    expect(acceptInvite).toContain('WHERE token_hash = ?')
    expect(acceptInvite).toContain('hashToken(token)')
  })

  test('every refusal answers with one message', () => {
    // The server distinguishes them so the page can offer "ask for a new one",
    // but a holder who was not the recipient must not learn which happened.
    const errors = [...acceptInvite.matchAll(/error:\s*'([^']+)'/g)].map(m => m[1])
      .filter(e => e !== 'Unauthorized')
    expect(errors.length).toBeGreaterThan(1)
    expect(new Set(errors).size).toBe(1)
  })

  test('access is granted before the invitation is consumed', () => {
    // If the second write fails, the worst case is a live token for access
    // already held, which the next attempt makes idempotent. The reverse order
    // could burn the invitation while granting nothing.
    expect(acceptInvite.indexOf('INSERT INTO site_members'))
      .toBeLessThan(acceptInvite.indexOf('UPDATE site_invites SET accepted_at'))
  })

  test('the pending list never selects the hash', () => {
    const start = routes.indexOf('async function listSiteInvites')
    expect(start).toBeGreaterThan(-1)
    const block = routes.slice(start, routes.indexOf('\nroute.', start))
    expect(block).toContain('accepted_at IS NULL')
    expect(block).not.toContain('token_hash')
  })

  test('revoking is scoped to the site in the DELETE itself', () => {
    // Scoped lookup, not lookup-then-check: an id from another site matches
    // nothing rather than relying on a separate comparison being remembered.
    expect(routeBlock(`route.delete('/api/sites/{siteId}/invites/{inviteId}'`))
      .toContain('DELETE FROM site_invites WHERE id = ? AND site_id = ?')
  })
})
