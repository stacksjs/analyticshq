import type { ConnectCodeStore, ConnectGrant, HqServiceAdapter, ReadPrincipal } from '@stacksjs/hq/service'
import { connectReadKeyName } from '../Support/read-key'

/**
 * AnalyticsHQ's side of the HQ connect contract (`@stacksjs/hq/service`).
 *
 * `buddy hq:connect analyticshq` asks for a code, a signed-in person approves
 * it on /cli/connect, and the CLI collects the site's id and read key. The
 * package owns the codes and the wire format. This file owns what they mean
 * here: which site, and what its read key may see.
 *
 * ## What the two keys are on this service
 *
 * The contract hands over an ingest key and a read key. Analytics has no
 * secret to write with: the tracker is a public script beaconing to a site id
 * (see app/Support/read-key.ts), so the thing an app writes with IS the site
 * id. That is what `ingestKey` carries, and it is why the CLI stores no key
 * for this service, only `ANALYTICSHQ_SITE_ID` and `ANALYTICSHQ_READ_KEY`.
 * Nothing is minted to fill the field.
 *
 * Nothing in this file touches the database. It is handed a `SiteStore`,
 * which is what lets the package's contract suite run against the same code
 * the routes use (tests/unit/hq-connect.test.ts).
 */

export interface HqSite {
  id: string
  name: string
  ownerId: number | null
}

export interface SiteStore {
  /** The owner's site of this name, compared case-insensitively. */
  findOwnedByName: (ownerId: number, name: string) => Promise<HqSite | null>
  /** Create a site for this owner and answer it, with a server-minted id. */
  create: (ownerId: number, name: string) => Promise<HqSite>
  /**
   * Mint a read key for the site and answer it. The only time it is ever
   * readable: what is kept is a hash (app/Support/site-tokens.ts).
   */
  issueReadKey: (siteId: string, name: string) => Promise<string>
  /** The site a presented read key reads, or null when it is not a live one. */
  findByReadKey: (readKey: string) => Promise<HqSite | null>
}

/** The signed-in person approving a connect. */
export interface HqUser {
  id: number | string
}

/** The one meter this service reports: page views recorded this month. */
export const PAGEVIEWS_METER = 'pageviews'

export interface AnalyticshqAdapterDeps {
  sites: SiteStore
  codes: ConnectCodeStore
  /** Public web origin, no trailing slash. */
  origin: () => string
  /** Page views recorded in the current month across this owner's sites. */
  pageviewsUsed: (ownerId: number) => Promise<number>
}

export function createAnalyticshqAdapter(deps: AnalyticshqAdapterDeps): HqServiceAdapter<HqUser> {
  const { sites } = deps

  async function provision(user: HqUser, { app }: { app: string }): Promise<ConnectGrant> {
    const ownerId = Number(user.id)
    if (!Number.isFinite(ownerId))
      throw new TypeError('A connect can only be approved by a signed-in user.')

    // The same rule as POST /api/sites: one site of a name per account.
    const site = await sites.findOwnedByName(ownerId, app) ?? await sites.create(ownerId, app)

    // Each connect is given a read key of its own. A read key is stored
    // hashed, so the one a first machine was given cannot be handed out again;
    // minting another leaves the first machine's deployment working, and each
    // can be revoked alone.
    const readKey = await sites.issueReadKey(site.id, connectReadKeyName(app))

    return {
      project: { id: site.id, name: site.name },
      // Public by design: it ships in the tracking snippet on every page.
      ingestKey: site.id,
      readKey,
      dashboardUrl: `${deps.origin()}/dashboard?site=${encodeURIComponent(site.id)}`,
    }
  }

  async function authenticateReadKey(presented: string): Promise<ReadPrincipal | null> {
    // Whether it is a live read key at all is the store's answer: a site id,
    // a session token or anything else resolves to nothing.
    const site = await sites.findByReadKey(presented)
    if (!site)
      return null
    // Usage is the ACCOUNT's, so the owner is the principal. A site nobody
    // owns is not metered, and the empty owner reads as exactly that below.
    return { owner: site.ownerId == null ? '' : String(site.ownerId), project: site.id }
  }

  return {
    service: 'analyticshq',
    approveUrl: code => `${deps.origin()}/cli/connect?code=${encodeURIComponent(code)}`,
    upgradeUrl: () => `${deps.origin()}/pricing`,
    codes: deps.codes,
    provision,
    authenticateReadKey,
    async usage(principal) {
      const ownerId = Number(principal.owner)
      if (principal.owner === '' || !Number.isFinite(ownerId))
        return [{ meter: PAGEVIEWS_METER, used: 0, limit: null }]
      // No plan caps page views (config/plans.ts lists only enforced limits),
      // so the count is reported against no limit rather than an invented one.
      return [{ meter: PAGEVIEWS_METER, used: await deps.pageviewsUsed(ownerId), limit: null }]
    },
  }
}
