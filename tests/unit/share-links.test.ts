/**
 * Share links: read-only, and no sign-in.
 *
 * The read gate in dashboard.stx grants access on a valid ?share= token with no
 * session, which has always been correct. But a `@push('scripts')` guard at the
 * foot of the same file read localStorage, found no token, and redirected to
 * /login before paint. The server rendered the entire dashboard and the client
 * threw it away — so a link handed to someone outside the team was unusable by
 * exactly the people it exists for, and presented as a login wall rather than a
 * bug.
 *
 * ## Why there is no expiry test here
 *
 * An earlier version of this file pinned a one-hour TTL. That was reverted:
 * permanent public read-only URLs are the norm for analytics — Fathom, Plausible
 * and Simple Analytics all ship them — and a link that dies an hour after it is
 * minted generates support tickets rather than safety. Revocation is the
 * control: POST rotates the token, DELETE removes it, and both kill the old URL
 * at once. If expiry is ever reintroduced, the gate below is where it goes.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dashboard = readFileSync(join(import.meta.dir, '../../resources/views/dashboard.stx'), 'utf8')
const routes = readFileSync(join(import.meta.dir, '../../routes/analytics.ts'), 'utf8')

/** The `?share=` branch of the read gate, bounded by the next branch. */
function shareBranch(): string {
  const i = dashboard.indexOf('else if (requestedSite && shareParam)')
  expect(i, 'the share branch of the read gate is gone').toBeGreaterThan(-1)
  const rest = dashboard.slice(i)
  return rest.slice(0, rest.indexOf('if (!viewGranted && ownedSites.length)'))
}

describe('a share view does not demand a sign-in', () => {
  test('the gate grants on a valid token with no session', () => {
    // This branch runs before any owner check and sets viewGranted itself. There
    // is no auth call in that path, and there must not be one.
    const branch = shareBranch()
    expect(branch).toContain('viewGranted = true')
    expect(branch).toContain('shareMode = true')
    expect(branch).not.toMatch(/requireAuth|middleware\('auth'\)|session\./)
  })

  test('the pre-paint /login redirect is not emitted on a share view', () => {
    // The regression that made the feature unusable. The guard is correct on an
    // owner view; it must simply not exist on a shared one.
    const guard = dashboard.indexOf('window.stx.navigate(\'/login\'')
    expect(guard).toBeGreaterThan(-1)

    const before = dashboard.slice(0, guard)
    const conditional = before.lastIndexOf('@if (!shareMode)')
    const push = before.lastIndexOf('@push(\'scripts\')')

    expect(conditional, 'the redirect is no longer wrapped in @if (!shareMode)').toBeGreaterThan(-1)
    // The condition must WRAP the push, not sit somewhere earlier in the file.
    expect(conditional).toBeLessThan(push)
    // …and close after the guard.
    expect(dashboard.slice(guard)).toContain('@endif')
  })

  test('the gate is server-side, not a client re-read of the query string', () => {
    // A client-side `?share=` check would be a second implementation of the same
    // rule, free to disagree with the first. The server has already decided.
    const guardBlock = dashboard.slice(dashboard.indexOf('@if (!shareMode)'))
    expect(guardBlock).not.toMatch(/location\.search|URLSearchParams/)
  })
})

describe('share links are revocable, which is what replaces expiry', () => {
  const block = routes.slice(routes.indexOf('/api/sites/{siteId}/share'))

  test('POST rotates the token, invalidating any previous link', () => {
    const mint = block.slice(0, block.indexOf('route.delete'))
    expect(mint).toContain('settings.share_token = token')
    // Freshly derived every time — reusing a stored value would leave old links live.
    expect(mint).toMatch(/createHash\('sha256'\)/)
  })

  test('DELETE removes it outright', () => {
    const revoke = block.slice(block.indexOf('route.delete'))
    expect(revoke).toContain('delete settings.share_token')
  })

  test('both are admin-gated', () => {
    // A viewer must not be able to mint a public URL to data they can only read.
    const mint = block.slice(0, block.indexOf('route.delete'))
    const revoke = block.slice(block.indexOf('route.delete'))
    for (const [name, b] of [['POST', mint], ['DELETE', revoke]] as const)
      expect({ name, gated: b.includes('requireSiteRole(request, siteId, \'admin\')') }).toEqual({ name, gated: true })
  })
})
