/**
 * Per-site roles (#19).
 *
 * The database-backed half — resolving a role, the owner/membership merge, the
 * member list — is exercised against a real Postgres separately, because it is
 * SQL and mocking it would only prove the mock. What is tested here is the part
 * that decides, and the wiring that a future edit could quietly loosen.
 *
 * The invariant behind all of it: site ids are PUBLIC. They ship in the tracking
 * snippet on every page of a customer's site, so knowing one must never be worth
 * anything.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASSIGNABLE_ROLES, isAssignableRole, satisfies } from '../../app/Analytics/access'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('the rank ordering', () => {
  test('each rank satisfies itself and everything below', () => {
    expect(satisfies('viewer', 'viewer')).toBe(true)
    expect(satisfies('admin', 'viewer')).toBe(true)
    expect(satisfies('admin', 'admin')).toBe(true)
    expect(satisfies('owner', 'viewer')).toBe(true)
    expect(satisfies('owner', 'admin')).toBe(true)
    expect(satisfies('owner', 'owner')).toBe(true)
  })

  test('and nothing above', () => {
    expect(satisfies('viewer', 'admin')).toBe(false)
    expect(satisfies('viewer', 'owner')).toBe(false)
    expect(satisfies('admin', 'owner')).toBe(false)
  })

  test('no role at all satisfies nothing', () => {
    // resolveSiteRole returns null for a stranger AND for a site that does not
    // exist. Neither may pass any gate.
    for (const required of ['viewer', 'admin', 'owner'] as const)
      expect(satisfies(null, required)).toBe(false)
  })
})

describe('assignable roles', () => {
  test('owner is not assignable', () => {
    // Owner is sites.owner_id, not a membership row. Letting the members endpoint
    // write 'owner' would create a second answer to "who owns this".
    expect(ASSIGNABLE_ROLES).toEqual(['viewer', 'admin'])
    expect(isAssignableRole('owner')).toBe(false)
  })

  test('anything unrecognised is rejected rather than defaulted', () => {
    for (const v of ['', 'Viewer', 'ADMIN', 'superuser', null, undefined, 1, {}])
      expect(isAssignableRole(v)).toBe(false)
  })
})

describe('the endpoints ask for the right rank', () => {
  const analytics = read('routes/analytics.ts')

  test('the site list returns shared sites, not just owned ones', () => {
    // Before #19 this was `WHERE owner_id = ?`, so an invited member authenticated
    // successfully, held a real role, and still saw an empty switcher.
    const i = analytics.indexOf(`route.get('/api/sites'`)
    const block = analytics.slice(i, analytics.indexOf('\nroute.', i + 10))
    expect(block).toContain('LEFT JOIN site_members')
    expect(block).toMatch(/WHERE s\.owner_id = \? OR m\.user_id IS NOT NULL/)
  })

  test('listing members needs only viewer', () => {
    // Knowing who else can see a site is part of knowing whether it is shared.
    const i = analytics.indexOf(`route.get('/api/sites/{siteId}/members'`)
    const block = analytics.slice(i, analytics.indexOf('\nroute.', i + 10))
    expect(block).toContain(`requireSiteRole(request, siteId, 'viewer')`)
  })

  test('the owner cannot be added as a member or removed as one', () => {
    // Both would "succeed" while changing nothing: resolveSiteRole takes the
    // higher of owner and membership, so an owner's viewer row is inert. Silently
    // inert is worse than refused.
    expect(analytics).toContain('The owner already has full access')
    expect(analytics).toContain('The owner cannot be removed')
  })

  test('adding a member requires an existing account', () => {
    // Creating a user from an unauthenticated address inside a member endpoint is
    // how invite flows turn into account-takeover flows. Until a real invite
    // exists, an unknown address is a 404.
    expect(analytics).toContain('No account with that email address')
  })
})
