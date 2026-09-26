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
import { ASSIGNABLE_ROLES, effectiveRole, isAssignableRole, satisfies } from '../../app/Analytics/access'

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
    const access = read('app/Analytics/access.ts')
    const i = access.indexOf('export async function listReachableSites')
    const block = access.slice(i, access.indexOf('\n}\n', i))
    expect(block).toContain('LEFT JOIN site_members')
    expect(block).toMatch(/WHERE s\.owner_id = \$1 OR m\.user_id IS NOT NULL/)
  })

  test('the API and the dashboard switcher read the same site list', () => {
    // Two copies of this query that disagreed is what #19 was.
    const i = analytics.indexOf(`route.get('/api/sites'`)
    const block = analytics.slice(i, analytics.indexOf('\nroute.', i + 10))
    expect(block).toContain('listReachableSites(uid)')
    expect(read('resources/views/dashboard.stx')).toContain('listReachableSites(user.id)')
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

describe('platform admins', () => {
  const access = read('app/Analytics/access.ts')

  test('an admin holds admin on every site, and never owner of one that is not theirs', () => {
    expect(effectiveRole({ owner: false, member: null, platformAdmin: true })).toBe('admin')
    expect(effectiveRole({ owner: false, member: 'viewer', platformAdmin: true })).toBe('admin')
    // Deleting a customer's site still takes the customer.
    expect(satisfies(effectiveRole({ owner: false, member: null, platformAdmin: true }), 'owner')).toBe(false)
    expect(effectiveRole({ owner: true, member: null, platformAdmin: true })).toBe('owner')
  })

  test('everyone else keeps exactly the rank they had', () => {
    expect(effectiveRole({ owner: false, member: null, platformAdmin: false })).toBe(null)
    expect(effectiveRole({ owner: false, member: 'viewer', platformAdmin: false })).toBe('viewer')
    expect(effectiveRole({ owner: false, member: 'admin', platformAdmin: false })).toBe('admin')
    expect(effectiveRole({ owner: true, member: 'viewer', platformAdmin: false })).toBe('owner')
  })

  test('admin is a flag on the row, never an email match', () => {
    // Registration does not verify addresses. An email rule would make the
    // install belong to whoever registers the address first.
    for (const file of ['app/Analytics/access.ts', 'routes/analytics.ts', 'resources/views/dashboard.stx', 'app/Gates.ts']) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      expect({ file, emailRule: /stacksjs\.(com|org)/.test(code) }).toEqual({ file, emailRule: false })
    }
    expect(access).toContain('SELECT is_platform_admin FROM users WHERE id = $1')
  })

  test('no request can set the flag', () => {
    const user = read('app/Models/User.ts')
    const i = user.indexOf('is_platform_admin:')
    const block = user.slice(i, user.indexOf('},', i))
    expect(block).toContain('fillable: false')
    expect(block).toContain('guarded: true')
  })

  test('the migration grants it to exactly one address', () => {
    const sql = read('database/migrations/0000000056-add-platform-admin.sql')
    expect(sql).toContain('"is_platform_admin" boolean NOT NULL DEFAULT false')
    expect(sql).toContain(`WHERE lower("email") = 'cloud@stacksjs.com'`)
  })

  test('only an admin\'s list is unfiltered, and only it names owners', () => {
    const i = access.indexOf('export async function listReachableSites')
    const block = access.slice(i, access.indexOf('\n}\n', i))
    const [adminBranch, memberBranch] = block.split(': await db.unsafe(')
    expect(adminBranch).toContain('platformAdmin')
    expect(adminBranch).toContain('owner_email')
    expect(adminBranch).not.toContain('WHERE')
    expect(memberBranch).not.toContain('owner_email')
    expect(memberBranch).toContain('WHERE s.owner_id = $1 OR m.user_id IS NOT NULL')
  })

  test('a missing flag column cannot lock an owner out', () => {
    // resolveSiteRole asks about the flag separately, so an owner's access never
    // depends on the users column existing.
    const i = access.indexOf('export async function resolveSiteRole')
    const block = access.slice(i, access.indexOf('\n}\n', i))
    expect(block).not.toContain('JOIN users')
    expect(block).toContain('!owner && member !== \'admin\' && await isPlatformAdmin(uid)')
  })
})

describe('what a platform admin is shown and given', () => {
  test('their own sites get the unbilled, unlimited tier', () => {
    const src = read('app/Analytics/entitlements.ts')
    const i = src.indexOf('export async function planForSite')
    const body = src.slice(i, src.indexOf('\n}\n', i))
    expect(body).toContain('if (await isPlatformAdmin(ownerId))')
    expect(body.indexOf('isPlatformAdmin(ownerId)')).toBeLessThan(body.indexOf('userIsPro(ownerId)'))
    expect(body).toContain('SELF_HOSTED_FEATURES')
  })

  test('the account page says Admin, with nothing to upgrade to', () => {
    const page = read('resources/views/account.stx')
    expect(page).toContain(`admin.set(d.platformAdmin === true)`)
    const adminBranch = page.slice(page.indexOf('@if (admin())\n          <StxLink'), page.indexOf('@elseif (pro())'))
    expect(adminBranch).not.toContain('Upgrade')
  })

  test('member since survives a users table without the social columns', () => {
    // created_at used to be selected with avatar and provider, which this
    // install's users table lacks, so the whole query threw.
    const me = read('app/Actions/MeAction.ts')
    expect(me).toContain(`'SELECT created_at FROM users WHERE id = $1'`)
    expect(me).toContain(`'SELECT avatar, provider FROM users WHERE id = $1'`)
    expect(me).not.toMatch(/SELECT[^']*created_at[^']*avatar|SELECT[^']*avatar[^']*created_at/)
  })
})
