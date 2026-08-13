/**
 * First-party CNAME proxying (#27).
 *
 * DNS is deliberately absent from this file. `verifyDomainDns` consults the real
 * world — that is the entire point of it — so mocking a resolver would only prove
 * the mock, and a suite that fails on a train is one people learn to skip. It is
 * verified separately against real records: `www.github.com` for the CNAME path,
 * and a hostname with no CNAME at all for the address fallback.
 *
 * What is here is the half that decides without asking anyone: which hostnames
 * are claimable, how they are normalised, and the wiring that keeps an unverified
 * domain from being treated as usable.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkDomainShape, snippetFor } from '../../app/Analytics/custom-domain'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const APP = 'analyticshq.org'

describe('which hostnames are claimable', () => {
  test('a subdomain of the customer\'s own site', () => {
    expect(checkDomainShape('stats.customer.com', APP).ok).toBe(true)
    expect(checkDomainShape('analytics.shop.co.uk', APP).ok).toBe(true)
  })

  test('an apex domain is refused, with advice that works', () => {
    // A bare apex cannot hold a CNAME under the DNS specification, so telling
    // someone to create one is advice that will fail. The message names the
    // shape that does work instead of just saying no.
    const verdict = checkDomainShape('customer.com', APP)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('stats.your-site.com')
  })

  test('our own hostnames cannot be claimed', () => {
    // Otherwise a customer could point their "custom domain" at the service
    // itself and have it render in their dashboard as theirs.
    for (const host of ['analyticshq.org', 'www.analyticshq.org', 'stats.analyticshq.org', 'a.b.analyticshq.org'])
      expect(checkDomainShape(host, APP).ok, host).toBe(false)
  })

  test('an IP address is not a hostname anyone can CNAME', () => {
    // Accepting one would also invite a certificate request for something that
    // cannot hold a valid certificate.
    for (const bad of ['1.2.3.4', '127.0.0.1', '::1', '2606:4700::1111'])
      expect(checkDomainShape(bad, APP).ok, bad).toBe(false)
  })

  test('malformed input is refused rather than repaired', () => {
    for (const bad of ['', '   ', 'not a hostname', '-bad.customer.com', 'bad-.customer.com', 'a..b.com', 'stats', null, undefined, 42, {}])
      expect(checkDomainShape(bad, APP).ok, JSON.stringify(bad)).toBe(false)
  })

  test('and anything absurdly long', () => {
    expect(checkDomainShape(`${'a'.repeat(250)}.customer.com`, APP).ok).toBe(false)
  })
})

describe('normalisation', () => {
  test('trims, lowercases, and drops the trailing dot', () => {
    // People paste all three. A hostname that differs only in case would defeat
    // the unique index and let two sites claim the same name.
    expect(checkDomainShape('  STATS.Customer.com. ', APP).domain).toBe('stats.customer.com')
  })

  test('tolerates a pasted URL', () => {
    expect(checkDomainShape('https://stats.customer.com/path?q=1', APP).domain).toBe('stats.customer.com')
    expect(checkDomainShape('http://stats.customer.com', APP).domain).toBe('stats.customer.com')
  })

  test('and a port', () => {
    expect(checkDomainShape('stats.customer.com:8443', APP).domain).toBe('stats.customer.com')
  })
})

describe('the snippet', () => {
  const APP_URL = 'https://analyticshq.org'

  test('uses the app origin when there is no custom domain', () => {
    expect(snippetFor('abc', APP_URL, null, null)).toContain('https://analyticshq.org/script.js')
  })

  test('uses the custom domain only once VERIFIED', () => {
    // Emitting it earlier hands the customer a snippet that silently collects
    // nothing until DNS catches up, and "I installed it and got no data" is the
    // worst failure this product has.
    expect(snippetFor('abc', APP_URL, 'stats.customer.com', null)).toContain('https://analyticshq.org/script.js')
    expect(snippetFor('abc', APP_URL, 'stats.customer.com', '2026-08-13T00:00:00.000Z'))
      .toContain('https://stats.customer.com/script.js')
  })

  test('carries the site id', () => {
    expect(snippetFor('abc123', APP_URL, null, null)).toContain('data-site="abc123"')
  })
})

describe('the wiring a later edit could quietly loosen', () => {
  const routes = code('routes/analytics.ts')

  test('declaring a domain never marks it verified', () => {
    // The DNS check is the only evidence of control that exists. A create path
    // that set verified_at would make the check decorative.
    const i = routes.indexOf(`route.post('/api/sites/{siteId}/domain'`)
    expect(i).toBeGreaterThan(-1)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect(block).toContain('custom_domain_verified_at = NULL')
    expect(block).not.toMatch(/custom_domain_verified_at\s*=\s*\?/)
  })

  test('re-declaring an already-verified domain resets verification', () => {
    // Otherwise a domain stays marked verified after being pointed elsewhere.
    const i = routes.indexOf(`route.post('/api/sites/{siteId}/domain'`)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect(block).toContain('SET custom_domain = ?, custom_domain_verified_at = NULL')
  })

  test('a hostname claimed by another site is refused, not stolen', () => {
    // Two sites on one hostname interleave their data with no way to separate it
    // afterwards, so this cannot be resolved after the fact.
    const i = routes.indexOf(`route.post('/api/sites/{siteId}/domain'`)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect(block).toContain('already in use by another site')
    expect(block).toContain('409')
  })

  test('verification only marks success after the DNS check passes', () => {
    const i = routes.indexOf(`route.post('/api/sites/{siteId}/domain/verify'`)
    expect(i).toBeGreaterThan(-1)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    const checked = block.indexOf('await verifyDomainDns')
    const marked = block.indexOf('SET custom_domain_verified_at = ?')
    expect(checked).toBeGreaterThan(-1)
    expect(marked).toBeGreaterThan(checked)
    // And a failed check must not fall through to marking it.
    expect(block).toContain('if (!verdict.ok)')
  })

  test('writing a domain requires admin, reading needs only viewer', () => {
    const gates: Array<[string, string]> = [
      [`route.get('/api/sites/{siteId}/domain'`, 'viewer'],
      [`route.post('/api/sites/{siteId}/domain'`, 'admin'],
      [`route.post('/api/sites/{siteId}/domain/verify'`, 'admin'],
      [`route.delete('/api/sites/{siteId}/domain'`, 'admin'],
    ]
    for (const [path, rank] of gates) {
      const i = routes.indexOf(path)
      expect(i, `${path} is missing`).toBeGreaterThan(-1)
      const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
      expect(block, path).toContain(`requireSiteRole(request, siteId, '${rank}')`)
    }
  })

  test('the tracker still derives its endpoint from its own src', () => {
    // This is what makes one static asset work from every host, and it is the
    // entire client half of the feature. Hardcoding an origin here would break
    // CNAME proxying without breaking anything a test would otherwise notice.
    const tracker = read('public/script.js')
    expect(tracker).toContain(`new URL(s.src, location.href).origin + '/collect'`)
  })
})
