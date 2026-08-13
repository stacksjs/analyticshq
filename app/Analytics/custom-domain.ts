/**
 * First-party CNAME proxying (#27).
 *
 * A customer points `stats.their-site.com` at us, and the tracking script and
 * `/collect` are served from there. A content blocker then sees a subdomain of
 * the site being visited rather than a known analytics vendor.
 *
 * ## The client half was already done
 *
 * `public/script.js` computes its endpoint as
 * `new URL(document.currentScript.src, location.href).origin + '/collect'`, so
 * the same static asset beacons back to whichever host served it — apex, legacy
 * domain, customer CNAME or localhost. Nothing in the tracker needed changing.
 *
 * What was missing is the server knowing which hostnames it has agreed to answer
 * for, and having proof the customer controls them.
 *
 * ## Why a DNS check is the proof
 *
 * There is no other evidence available. The customer types a hostname; the only
 * thing that distinguishes "mine" from "someone else's" is whether they can make
 * it point here, which requires control of the zone. So verification resolves the
 * name and checks it actually leads to us.
 *
 * That check is not decoration. The deployment issues a TLS certificate per
 * accepted domain, so an unverified field is a way to make us request
 * certificates for domains we have no relationship with — and a customer could
 * otherwise claim a hostname belonging to someone else and have it render in
 * their dashboard as theirs.
 *
 * ## What this module deliberately does not do
 *
 * Issue certificates or configure the edge. Terminating TLS for
 * `stats.their-site.com` is deployment work — see the operator notes on the
 * issue. This module decides whether a hostname is claimable and whether DNS
 * currently agrees; acting on that answer is the platform's job.
 */

import { resolve4, resolveCname } from 'node:dns/promises'

export interface DomainVerdict {
  ok: boolean
  /** Why it was refused, phrased for the person who typed it. */
  reason?: string
}

/**
 * Hostnames nobody may claim: our own, and anything that would let a customer's
 * "custom domain" shadow the service itself.
 */
function reservedSuffixes(appHost: string): string[] {
  const base = appHost.replace(/^www\./, '')
  return [base, `www.${base}`]
}

/**
 * Is this a hostname a customer could plausibly own and point at us?
 *
 * Shape only — no network. Exported so the rules can be tested exhaustively.
 */
export function checkDomainShape(raw: unknown, appHost: string): DomainVerdict & { domain?: string } {
  if (typeof raw !== 'string')
    return { ok: false, reason: 'That is not a hostname.' }

  // Tolerate a pasted URL or a trailing dot, both of which people do.
  let domain = raw.trim().toLowerCase().replace(/\.$/, '')
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')

  if (!domain)
    return { ok: false, reason: 'That is not a hostname.' }
  if (domain.length > 253)
    return { ok: false, reason: 'That hostname is too long.' }

  // An IP address is not a name anyone can CNAME, and accepting one would invite
  // a certificate request for something that cannot have a valid one.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) || domain.includes(':'))
    return { ok: false, reason: 'Use a hostname, not an IP address.' }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain))
    return { ok: false, reason: 'That is not a valid hostname.' }

  // A bare apex cannot hold a CNAME under the DNS specification, and telling
  // someone to create one is advice that will not work. Providers offering
  // ALIAS/ANAME records are the exception, which is why verification also accepts
  // an address match — but the guidance should still steer to a subdomain.
  const labels = domain.split('.')
  if (labels.length < 3)
    return { ok: false, reason: 'Use a subdomain, for example stats.your-site.com — an apex domain cannot hold a CNAME record.' }

  for (const reserved of reservedSuffixes(appHost)) {
    if (domain === reserved || domain.endsWith(`.${reserved}`))
      return { ok: false, reason: 'That hostname belongs to this service.' }
  }

  return { ok: true, domain }
}

/**
 * Does DNS currently point this hostname at us?
 *
 * Accepts either shape, because both are legitimate ways to do it:
 *
 *   - a CNAME to our host, which is the documented instruction
 *   - an A record matching ours, which is what providers that flatten CNAMEs
 *     (Cloudflare, Route 53 ALIAS) actually publish
 *
 * Checking only for a CNAME would fail verification for customers who followed
 * the instructions correctly on one of those providers, and the failure would be
 * indistinguishable from having done nothing.
 */
export async function verifyDomainDns(domain: string, target: string): Promise<DomainVerdict> {
  const want = target.toLowerCase().replace(/\.$/, '')

  const cnames = await resolveCname(domain).catch(() => [] as string[])
  for (const record of cnames) {
    const value = String(record).toLowerCase().replace(/\.$/, '')
    if (value === want || value.endsWith(`.${want}`))
      return { ok: true }
  }

  // Fall back to comparing addresses. Both lookups can fail independently — a
  // host with only a CNAME has no direct A record of its own to compare — so
  // neither failure is treated as an answer on its own.
  const [theirs, ours] = await Promise.all([
    resolve4(domain).catch(() => [] as string[]),
    resolve4(want).catch(() => [] as string[]),
  ])

  if (theirs.length && ours.length && theirs.some(a => ours.includes(a)))
    return { ok: true }

  if (!cnames.length && !theirs.length)
    return { ok: false, reason: `${domain} does not resolve yet. DNS changes can take a few minutes to propagate.` }

  return { ok: false, reason: `${domain} does not point to ${want} yet.` }
}

/** The snippet a site should embed, using its verified domain when it has one. */
export function snippetFor(siteId: string, appUrl: string, customDomain: string | null, verifiedAt: string | null): string {
  // The custom domain is only used once verified. Emitting it earlier would give
  // the customer a snippet that silently collects nothing until DNS catches up,
  // and "I installed it and got no data" is the worst failure mode this product
  // has.
  const origin = customDomain && verifiedAt ? `https://${customDomain}` : appUrl.replace(/\/$/, '')
  return `<script defer src="${origin}/script.js" data-site="${siteId}"></script>`
}
