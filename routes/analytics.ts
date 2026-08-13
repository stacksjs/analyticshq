/**
 * analyticshq — ingest + stats API.
 *
 * The public tracker (the static `public/script.js`) beacons page views and
 * custom events to `POST /collect`. The dashboard reads aggregates from the
 * `GET /api/sites/{siteId}/*` endpoints. All storage is PostgreSQL, queried
 * through bun-query-builder's `db`.
 *
 * Every route here must be reachable through the views server's proxy, which
 * forwards only `/api/*` and mutating methods (POST/PUT/PATCH/DELETE) to this
 * backend. A plain `GET` at the root would 404 against the STX views instead —
 * which is why the tracker is a static asset and `/health` lives under `/api`.
 */

import process from 'node:process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { formatCount, renderBadge, renderSparkline, sanitizeLabel } from '../app/Analytics/badge'
import { ASSIGNABLE_ROLES, isAssignableRole, listSiteMembers, resolveSiteRole, satisfies, siteExists, type SiteRole } from '../app/Analytics/access'
import { ALERT_CONDITIONS, ALERT_METRICS, isAlertCondition, isAlertMetric, isRelative } from '../app/Analytics/alerts'
import { checkWebhookUrl } from '../app/Alerts/url-safety'
import { computeFunnel, FUNNEL_SCOPES, isFunnelScope, parseSteps, validateSteps } from '../app/Analytics/funnels'
import { buildFilterSql, collectFilters, FILTER_COLUMNS, FILTER_OPS, MAX_FILTERS, MAX_PATTERN_LENGTH, mergeFilters, parseFilterKey, parseSegmentFilters, segmentPopulation, shouldSuppress, validateFilters } from '../app/Analytics/filters'
import { formatMinor, normalizeCurrency, resolveConversionAmount, toMinorUnits } from '../app/Analytics/money'
import { checkDomainShape, snippetFor, verifyDomainDns } from '../app/Analytics/custom-domain'
import { response, route } from '@stacksjs/router'
import privacy from '../config/privacy'
import { getDailySalt } from '../app/Analytics/salt'
import {
  cleanReferrer,
  clientIp,
  geoCountry,
  hashVisitor,
  isBot,
  parseUserAgent,
  randomId,
  referrerSource,
} from '../app/Analytics/tracking'

/**
 * Postgres positional-placeholder shim. bun-query-builder's `db.unsafe()` passes
 * SQL through verbatim, and Postgres binds with `$1..$n`, not MySQL's `?`. Rewrite
 * each `?` to `$n` in order so the existing `?`-style queries — including the
 * dynamically-built filter fragments whose placeholder count varies — run
 * unchanged on Postgres. No-op on dialects that use `?` (sqlite/mysql). This is
 * the ONLY placeholder style used in this file; there are no literal `?` in any
 * SQL string, so the blanket replace is safe.
 */
const IS_PG = (process.env.DB_CONNECTION ?? 'postgres') === 'postgres'
function pgq(sql: string, params?: unknown[]): Promise<any> {
  const bound = IS_PG ? ((): string => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`) })() : sql
  return db.unsafe(bound, params ?? []) as Promise<any>
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

/** Parse a `from`/`to` window from the query string, defaulting to last 7d. */
function window(req: { query: Record<string, any> }): { from: string, to: string } {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 864e5)
  const from = (req.query?.from as string) || weekAgo.toISOString()
  const to = (req.query?.to as string) || now.toISOString()
  return { from, to }
}

/**
 * Build the filter fragment for a request (#23).
 *
 * The grammar, the columns and the SQL now live in app/Analytics/filters.ts, so
 * saved segments and live query params are the same thing rather than two
 * spellings of it. This stays as the request-shaped adapter every report endpoint
 * already calls, which is why they all gained operators at once.
 *
 * Bare `?country=US` is still equality, so every existing dashboard link and
 * click-to-filter URL keeps working unchanged.
 *
 * Returns an `error` when the filters are unusable — an over-long pattern, an
 * unknown operator — so the endpoint can answer 400 rather than pass something
 * malformed to the database and turn it into a 500.
 */
function readFilters(req: { query: Record<string, any> }): FilterResult {
  const specs = collectFilters(req.query ?? {})
  const validated = validateFilters(specs)
  if ('error' in validated)
    return { sql: '', params: [], count: 0, error: validated.error }
  return { ...buildFilterSql(specs), count: specs.length }
}

/** A parsed filter set: the SQL fragment, its parameters, and how many are active. */
interface FilterResult {
  sql: string
  params: unknown[]
  /** Number of active filters. Zero means unfiltered, which is never suppressed. */
  count: number
  error?: string
}

/**
 * Postgres SQLSTATE 2201B, `invalid_regular_expression`.
 *
 * Regex syntax is not validated before the query, on purpose. Postgres uses POSIX
 * regular expressions and JavaScript does not, so pre-checking with `new RegExp`
 * would reject valid patterns and accept invalid ones — a gate that is wrong in
 * both directions. Postgres is the authority on what it will accept, so it is
 * asked, and its complaint is turned into a 400 instead of an uncaught 500.
 *
 * The message is passed through because it describes the caller's own input
 * ("parentheses () not balanced") and is exactly what someone editing a pattern
 * needs to see. It reveals nothing about the data or the schema.
 */
function invalidPatternMessage(error: unknown): string | null {
  const e = error as { errno?: unknown, message?: unknown }
  if (String(e?.errno) !== '2201B')
    return null
  const message = String(e?.message ?? '')
  const detail = message.replace(/^[\s\S]*?invalid regular expression:\s*/i, '').trim()
  return detail || 'invalid pattern'
}

/**
 * Run a report query that carries user-supplied filters.
 *
 * Returns rows, or a ready-to-send 400 when the failure was a bad pattern.
 * Anything else is rethrown — a broken query of ours is not the caller's fault
 * and must not be reported as if it were.
 */
async function filteredQuery(sql: string, params: unknown[]): Promise<{ rows: any[] } | { response: Response }> {
  try {
    return { rows: (await pgq(sql, params)) ?? [] }
  }
  catch (error) {
    const bad = invalidPatternMessage(error)
    if (bad)
      return { response: json({ error: `That pattern is not valid: ${bad}` }, 400) }
    throw error
  }
}

/**
 * Resolve `?segment=<id>` into filters and merge the request's own on top.
 *
 * Loaded per request rather than cached: a segment is small, this is one indexed
 * primary-key read, and a stale cache would show a reader the definition they
 * just edited rather than the one they saved.
 */
async function readFiltersWithSegment(request: any, siteId: string): Promise<FilterResult> {
  const segmentId = request.query?.segment
  if (typeof segmentId !== 'string' || !segmentId)
    return readFilters(request)

  // Scoped by site as well as id: a segment id from another site must not narrow
  // a report here, and must not reveal by its absence that it exists elsewhere.
  const row = (await pgq(`SELECT filters FROM segments WHERE id = ? AND site_id = ? LIMIT 1`, [segmentId, String(siteId)]))?.[0]
  if (!row)
    return { sql: '', params: [], count: 0, error: 'Segment not found' }

  const merged = mergeFilters(parseSegmentFilters(row.filters), request.query ?? {})
  const specs = collectFilters(merged)
  const validated = validateFilters(specs)
  if ('error' in validated)
    return { sql: '', params: [], count: 0, error: validated.error }
  return { ...buildFilterSql(specs), count: specs.length }
}

/**
 * Withhold a filtered report that would describe too few people (#40).
 *
 * Returns a ready-to-send response when the segment is too small, else null.
 * `count` is how many filters are active, and it is why an unfiltered report is
 * never suppressed: the disclosure comes from narrowing, not from smallness.
 *
 * 422 rather than 200-with-a-flag, deliberately. A suppressed report returned as
 * a success carrying zeroes is indistinguishable from a real report of zero, and
 * every client that forgot to check the flag would quietly render "0 visitors"
 * as though it were measured. A status the client cannot ignore is the honest
 * shape for "this exists and you may not see it".
 *
 * The response says the threshold. It does not say the actual population, which
 * would hand back the very number the guard exists to withhold — "suppressed
 * because 1" is a disclosure.
 */
async function suppressedResponse(siteId: string, from: string, to: string, flt: FilterResult): Promise<Response | null> {
  const minimum = privacy.minSegmentSize
  if (minimum <= 0 || flt.count === 0)
    return null

  const population = await segmentPopulation(String(siteId), from, to, flt, pgq)
  if (!shouldSuppress(minimum, flt.count, population))
    return null

  return json({
    error: `This segment matches fewer than ${minimum} visitors, so its reports are withheld to keep individuals unidentifiable.`,
    suppressed: true,
    minSegmentSize: minimum,
  }, 422)
}

/** Trim a UTM param to a non-empty varchar(255), or null when absent/blank. */
function utmParam(v: unknown): string | null {
  if (typeof v !== 'string')
    return null
  const t = v.trim()
  return t ? t.slice(0, 255) : null
}

// Clip a user-supplied string to the varchar(255) column width so an over-long value can't
// overflow the page_views insert — on Postgres an over-length varchar insert errors (22001),
// which would 500 the beacon and, via the sessions FK, drop the whole pageview. Used for
// referrer/title, which the tracker sends untruncated (UTMs already go through utmParam's cap).
function clip255(v: unknown): string | null {
  if (v == null)
    return null
  const s = String(v)
  return s.length > 255 ? s.slice(0, 255) : s
}

/**
 * Goal-matching contract. A goal targets either a `pageview` (matched against
 * the page path) or an `event` (matched against the custom event name), using
 * one of three `match_type`s. Returns whether the current hit fires this goal.
 * NOTE: duration_minutes-based goals are out of scope this round (future work).
 */
interface GoalRow {
  id: string
  type: string | null
  pattern: string | null
  match_type: string | null
  value: number | null
  /** Revenue fallback when the event does not send its own amount (#22). */
  default_amount_minor: number | string | null
  currency: string | null
}

function matchesGoal(
  goal: GoalRow,
  hit: { isPageview: boolean, path: string, eventName: string },
): boolean {
  const wantPageview = goal.type === 'pageview'
  // A pageview goal never matches an event hit, and vice-versa.
  if (wantPageview !== hit.isPageview)
    return false
  const subject = wantPageview ? hit.path : hit.eventName
  const pattern = goal.pattern ?? ''
  switch (goal.match_type) {
    case 'contains':
      return subject.includes(pattern)
    case 'starts_with':
      return subject.startsWith(pattern)
    case 'exact':
    default:
      return subject === pattern
  }
}

/**
 * Deterministic conversion id = sha256(session_id|goal_id), truncated. Combined
 * with insertOrIgnore (which emits `ON CONFLICT DO NOTHING` on the postgres
 * dialect), this enforces exactly one conversion per session per goal: a repeat
 * beacon in the same session recomputes the same id and the insert is a no-op.
 */
function conversionId(sessionId: string, goalId: string): string {
  return createHash('sha256').update(`${sessionId}|${goalId}`).digest('hex').slice(0, 32)
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

route.options('/collect', () => new Response(null, { status: 204, headers: CORS }))

route.post('/collect', async (request: any) => {
  const body = request.jsonBody ?? {}
  const siteId = body.s
  if (!siteId)
    return json({ error: 'missing site' }, 400)

  const ua = request.headers?.get('user-agent') ?? ''
  if (isBot(ua))
    return new Response(null, { status: 204, headers: CORS })

  // Global Privacy Control, enforced server-side as well as in the tracker (#8).
  //
  // Both halves are needed for different reasons. The client check stops the
  // request being made at all, which is what a visitor actually wants. This one
  // is the backstop: `Sec-GPC` is attached by the browser itself, so it still
  // arrives from an old cached copy of script.js, a self-hosted or proxied
  // tracker, or a hand-rolled beacon — none of which run our client code.
  //
  // 204, the same as the bot path: the tracker ignores the body, and an error
  // status would only invite a retry.
  if (privacy.respectDnt && request.headers?.get('sec-gpc') === '1')
    return new Response(null, { status: 204, headers: CORS })

  const ip = clientIp(request.headers)
  // Per-site-per-day secret, not the UTC date (#9). Memoised per site-day, so
  // this is a database round-trip once a day, not once a beacon.
  const visitorId = hashVisitor(ip, ua, String(siteId), await getDailySalt(String(siteId)))
  // Server-side sessionization (no client storage → cookieless/consent-free, the point of a
  // privacy-first tracker): a session is one anonymous visitor's activity within a rolling
  // 30-minute inactivity window. Primary path: reuse the session id from this visitor's most
  // recent hit in the window (page_views(visitor_id) index). On a miss (or lookup failure) the
  // fallback id is DETERMINISTIC — sha256(site|visitor|30-min bucket) — NOT random, so two
  // concurrent first-hit beacons from one visitor (e.g. the load pageview + a pushState pv, or
  // a beacon during a DB blip) compute the SAME id and the sessions insertOrIgnore dedups them
  // into one session instead of racing into two. Accepted cookieless trade-offs (as in
  // Fathom/Plausible): a visitor whose IP changes mid-visit, or a visit crossing the daily
  // visitor-salt rotation at UTC midnight, starts a new session. This per-beacon lookup rides the
  // page_views(site_id, visitor_id) index on Postgres; cache the active session if it ever gets hot.
  const SESSION_WINDOW_MS = privacy.sessionWindowMinutes * 60 * 1000
  const sessionSince = new Date(Date.now() - SESSION_WINDOW_MS).toISOString()
  const recentSession = (await pgq(
    `SELECT session_id FROM page_views WHERE site_id = ? AND visitor_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1`,
    [String(siteId), visitorId, sessionSince],
  ).catch(() => [])) as Array<{ session_id: string }>
  const sessionId = recentSession[0]?.session_id
    ? String(recentSession[0].session_id)
    : createHash('sha256').update(`${siteId}|${visitorId}|${Math.floor(Date.now() / SESSION_WINDOW_MS)}`).digest('hex').slice(0, 32)
  const info = parseUserAgent(ua)
  // 'none' records no location at all; there is deliberately no city/region
  // option, since adding one would be a product decision, not config (#11).
  const country = privacy.geo.granularity === 'country' ? geoCountry(request.headers) : undefined
  const now = new Date().toISOString()

  let url: URL | null = null
  try {
    url = body.u ? new URL(body.u) : null
  }
  catch { /* ignore malformed url */ }
  const path = clip255(url?.pathname) ?? '/'
  const source = referrerSource(body.r)

  // Ensure the site row exists before any child insert. sessions, page_views,
  // custom_events and conversions all FK to sites.id, so a first-ever hit for a
  // site would otherwise fail the constraint (500). insertOrIgnore self-registers
  // the site on its first beacon and is a no-op on every hit after.
  await db.insertOrIgnore('sites', {
    id: String(siteId),
    created_at: now,
  }).catch(() => {})

  // Create the session on the first hit; ignore on later hits (same session id).
  await db.insertOrIgnore('sessions', {
    id: sessionId,
    site_id: String(siteId),
    visitor_id: visitorId,
    entry_path: path,
    exit_path: path,
    referrer: cleanReferrer(body.r),
    referrer_source: source,
    country: country ?? null,
    device_type: info.deviceType,
    browser: info.browser,
    os: info.os,
    page_view_count: 0,
    event_count: 0,
    is_bounce: true,
    duration: 0,
    started_at: now,
  }).catch(() => {})

  const event = body.e ?? 'pageview'
  if (event === 'pageview') {
    await db.insertInto('page_views').values({
      id: randomId(),
      site_id: String(siteId),
      session_id: sessionId,
      visitor_id: visitorId,
      path,
      hostname: url?.hostname ?? null,
      referrer: cleanReferrer(body.r),
      referrer_source: source,
      utm_source: utmParam(body.utm_source),
      utm_medium: utmParam(body.utm_medium),
      utm_campaign: utmParam(body.utm_campaign),
      utm_content: utmParam(body.utm_content),
      utm_term: utmParam(body.utm_term),
      country: country ?? null,
      device_type: info.deviceType,
      browser: info.browser,
      browser_version: null,
      os: info.os,
      os_version: null,
      // title / screen_width / screen_height are no longer collected (#10) — the
      // tracker stops sending them and the columns are dropped by migration 37.
      // Nothing ever read them: every SELECT in this file is column-explicit and
      // none names them, and device_type comes from the User-Agent above.
      is_unique: false,
      is_bounce: false,
      timestamp: now,
    }).execute()
  }
  else {
    // Reserved auto-tracked events (Outbound Link / File Download) carry only a url. Store
    // it canonically as {"url":...} regardless of any extra keys / key-order a caller sends,
    // so the dashboard's GROUP BY properties aggregates exactly one row per URL — a client
    // can't split or pollute a URL's row by appending junk keys.
    let props = body.p ? JSON.stringify(body.p) : null
    if ((String(event) === 'Outbound Link' || String(event) === 'File Download') && body.p && body.p.url) {
      let url = String(body.p.url)
      props = JSON.stringify({ url })
      // properties is varchar(255): trim the url until the wrapped JSON fits, so it stays
      // valid JSON (the dashboard JSON.parses it) and never overflows the column — on Postgres
      // an over-length varchar insert errors (22001) and would 500 the beacon. Only pathologically
      // long hrefs hit the loop. (TODO: widen custom_events.properties for full-length urls.)
      while (props.length > 255 && url.length) {
        url = url.slice(0, -8)
        props = JSON.stringify({ url })
      }
    }
    // .catch like the sites/sessions inserts above: a storage failure (e.g. an over-length
    // non-reserved props blob under strict sql_mode) must never 500 the public beacon.
    await db.insertInto('custom_events').values({
      id: randomId(),
      site_id: String(siteId),
      session_id: sessionId,
      visitor_id: visitorId,
      name: String(event),
      properties: props,
      path,
      timestamp: now,
    }).execute().catch(() => {})
  }

  // Goal / conversion matching. Runs AFTER the session insert above so the
  // conversions.session_id FK is satisfied. Wrapped in try/catch (and each
  // insert is insertOrIgnore + .catch) so a goals failure can never break the
  // pageview 204. Hot-path cost: one indexed SELECT per beacon (+ up to N tiny
  // insertOrIgnores); goals-per-site is small, so this is fine for now — cache
  // per-site active goals with a short TTL later if it ever matters.
  try {
    const isPageview = event === 'pageview'
    const eventName = String(event)
    const goals = await pgq(
      `SELECT id, type, pattern, match_type, value, default_amount_minor, currency FROM goals WHERE site_id = ? AND is_active = true LIMIT 100`,
      [String(siteId)],
    )

    // Only read the site's default currency when a goal actually matched — most
    // beacons are ordinary pageviews matching nothing, and this is the hot path.
    let siteCurrency: string | null = null
    if ((goals ?? []).length) {
      const row = (await pgq(`SELECT currency FROM sites WHERE id = ? LIMIT 1`, [String(siteId)]))?.[0]
      siteCurrency = normalizeCurrency(row?.currency)
    }

    // Revenue sent by the event itself (#22): analyticshq('Purchase', { value: 19.99,
    // currency: 'USD' }). Parsed once per beacon rather than per matching goal.
    //
    // This is as trustworthy as the site's own front end and no more — /collect is
    // a public endpoint and the site id ships in the snippet, so anyone can post a
    // fabricated amount. That is inherent to client-side revenue tracking and is
    // true of every product in this category; it is written down here so nobody
    // later mistakes these figures for accounting data.
    const eventProps = (body.p && typeof body.p === 'object') ? body.p as Record<string, unknown> : {}
    const eventCurrency = normalizeCurrency(eventProps.currency)
    const eventAmountRaw = eventProps.value ?? eventProps.revenue ?? eventProps.amount

    for (const goal of (goals ?? []) as GoalRow[]) {
      if (!matchesGoal(goal, { isPageview, path, eventName }))
        continue

      // Precedence lives in resolveConversionAmount so it can be tested without a
      // running server: event amount over goal default, event currency over the
      // goal's over the site's.
      const { amountMinor, currency } = resolveConversionAmount({
        eventAmount: eventAmountRaw,
        eventCurrency,
        goalDefaultMinor: goal.default_amount_minor,
        goalCurrency: goal.currency,
        siteCurrency,
      })

      // Deterministic id + ON CONFLICT DO NOTHING => once per session per goal. Stores the
      // amount, its currency, and this beacon's attribution + timestamp.
      await db.insertOrIgnore('conversions', {
        id: conversionId(sessionId, goal.id),
        site_id: String(siteId),
        goal_id: goal.id,
        visitor_id: visitorId,
        session_id: sessionId,
        value: goal.value ?? null,
        // Currency is only stored alongside an amount. A currency with no amount
        // would create rows that group into a revenue report contributing nothing,
        // which reads as "this currency earned zero" rather than "no sale here".
        amount_minor: amountMinor,
        currency,
        path,
        referrer_source: source,
        utm_source: utmParam(body.utm_source),
        utm_campaign: utmParam(body.utm_campaign),
        timestamp: now,
      }).catch(() => {})
    }
  }
  catch { /* goals/conversions are best-effort; never block the beacon */ }

  return new Response(null, { status: 204, headers: CORS })
})
  // Public cross-origin, cookieless tracking beacon — no CSRF cookie can ride
  // along (like a webhook), so opt out of the default-on CSRF check.
  .skipCsrf()

// ---------------------------------------------------------------------------
// Stats (dashboard)
// ---------------------------------------------------------------------------

// Reads go through db.unsafe (parameterized): schema-independent, correct for
// GROUP BY aggregates, and skips the global soft-delete filter these tables
// don't participate in. Timestamps are stored as ISO strings, whose
// lexicographic order matches chronological order, so string range works.

// ---------------------------------------------------------------------------
// Ownership helpers (shared by the sites + goals management endpoints)
// ---------------------------------------------------------------------------

/**
 * The authenticated user's id, as set by the `auth` middleware. It caches the
 * resolved user on the request (`_authenticatedUser`) for both bearer and cookie
 * auth and 401s before the handler runs when neither is present — so on an
 * auth-guarded route this is populated. Returns a string for dialect-agnostic
 * comparison (owner_id is compared in JS, never bound into an int column).
 */
function authUserId(request: any): string | null {
  const id = request?._authenticatedUser?.id
  return id == null ? null : String(id)
}

/**
 * Ownership gate for the site-scoped management endpoints. Returns null when the
 * caller owns the site, otherwise a ready-to-return error Response:
 *   - 401 when no user is resolved (defense-in-depth; `.middleware('auth')` already guards)
 *   - 404 when the site row doesn't exist
 *   - 403 when the site is ownerless (self-registered via /collect — claimable
 *     only through POST /api/sites) or owned by someone else
 * Site ids are public (embedded in the tracking snippet), so distinguishing 404
 * from 403 leaks nothing sensitive.
 */
/**
 * Gate a site-scoped endpoint on a minimum role (#19).
 *
 * `viewer` reads reports, `admin` also changes settings/goals/share/members, and
 * `owner` alone destroys things. Every call site names the rank it needs, so the
 * requirement is readable at the endpoint rather than inferred from one shared
 * function that meant "owner" everywhere.
 *
 * 404 vs 403 is deliberate. A site that does not exist answers 404; a site that
 * exists but is not yours answers 403. That does leak existence to an
 * authenticated caller who guesses an id — but site ids are PUBLIC, they ship in
 * the tracking snippet on every page of a customer's site, so there is nothing to
 * conceal and collapsing the two would only make real 404s undebuggable. The
 * secret is the data, and that is what the role check protects.
 */
async function requireSiteRole(request: any, siteId: string, required: SiteRole): Promise<Response | null> {
  const uid = authUserId(request)
  if (!uid)
    return json({ error: 'Unauthorized' }, 401)
  const role = await resolveSiteRole(uid, siteId)
  if (role == null) {
    if (!(await siteExists(siteId)))
      return json({ error: 'Site not found' }, 404)
    return json({ error: 'Forbidden' }, 403)
  }
  if (!satisfies(role, required))
    return json({ error: 'Forbidden' }, 403)
  return null
}

/** Destructive and ownership-transferring operations only. */
async function requireSiteOwner(request: any, siteId: string): Promise<Response | null> {
  return requireSiteRole(request, siteId, 'owner')
}

// ---------------------------------------------------------------------------
// Sites (management API)
// ---------------------------------------------------------------------------
// A logged-in user "adds a site" to get a tracking id they OWN. /collect
// self-registers unknown ids as ownerless shadow rows (ingest-only), which stay
// unmanageable until owned here. The id is minted server-side (random,
// unguessable) rather than caller-supplied, so nobody can claim an already-live
// public site-id embedded in someone else's tracking snippet.

route.options('/api/sites', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites', async (request: any) => {
  const uid = authUserId(request)
  if (!uid)
    return json({ error: 'Unauthorized' }, 401)
  // Owned sites AND sites shared with this user (#19). Before memberships this
  // was `WHERE owner_id = ?`, which is why an invited member could authenticate,
  // hold a valid role, and still see an empty site list — the switcher reads this.
  //
  // `role` comes back with each row so the dashboard can hide controls the user
  // cannot use. It is a convenience for the UI, never the check: every endpoint
  // re-resolves the role server-side.
  const rows = await pgq(
    `SELECT s.id, s.name, s.domains, s.timezone, s.currency, s.is_active, s.created_at,
            CASE WHEN s.owner_id = ? THEN 'owner' ELSE m.role END AS role
     FROM sites s
     LEFT JOIN site_members m ON m.site_id = s.id AND m.user_id = ?
     WHERE s.owner_id = ? OR m.user_id IS NOT NULL
     ORDER BY s.created_at DESC`,
    [Number(uid), Number(uid), Number(uid)],
  )
  return json({ sites: rows ?? [] })
}).middleware('auth')

// ---------------------------------------------------------------------------
// Members (#19)
// ---------------------------------------------------------------------------
// Membership is by user id, resolved from an email address that must already
// have an account. There is no invite-by-email flow yet: creating a user from an
// unauthenticated address is an account-creation path, and bolting one onto a
// member endpoint is how invitation systems become account-takeover systems.
// Until that exists properly, adding someone who has not signed up answers 404.

route.options('/api/sites/{siteId}/members', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/members', async (request: any) => {
  const siteId = request.params.siteId
  // Viewer, not admin: knowing who else can see a site is part of knowing whether
  // it is being shared, and a viewer who cannot see that has no way to notice.
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  return json({ members: await listSiteMembers(siteId) })
}).middleware('auth')

route.post('/api/sites/{siteId}/members', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const body = request.jsonBody ?? {}
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const role = body.role
  if (!email)
    return json({ error: 'email is required' }, 400)
  if (!isAssignableRole(role))
    return json({ error: `role must be one of ${ASSIGNABLE_ROLES.join(', ')}` }, 400)

  const users = await pgq(`SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1`, [email])
  const userId = users?.[0]?.id
  if (userId == null)
    return json({ error: 'No account with that email address' }, 404)

  // The owner is not a member row. Adding them would create a second, lower
  // answer to "what is their role", and resolveSiteRole takes the higher of the
  // two — so it would be silently inert rather than wrong. Rejecting says so.
  const site = (await pgq(`SELECT owner_id FROM sites WHERE id = ? LIMIT 1`, [String(siteId)]))?.[0]
  if (site?.owner_id != null && Number(site.owner_id) === Number(userId))
    return json({ error: 'The owner already has full access' }, 409)

  // Re-adding an existing member changes their role rather than erroring: the
  // primary key is (site_id, user_id), and "invite again with a different role"
  // is the obvious way to express a promotion.
  await pgq(
    `INSERT INTO site_members (site_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (site_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [String(siteId), Number(userId), role, new Date().toISOString()],
  )
  return json({ members: await listSiteMembers(siteId) })
}).middleware('auth').skipCsrf()

route.options('/api/sites/{siteId}/members/{userId}', () => new Response(null, { status: 204, headers: CORS }))

route.delete('/api/sites/{siteId}/members/{userId}', async (request: any) => {
  const siteId = request.params.siteId
  const targetId = Number(request.params.userId)
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  // The owner has no membership row to delete, so this would report success while
  // changing nothing — the shape of "removed the owner" without doing it.
  const site = (await pgq(`SELECT owner_id FROM sites WHERE id = ? LIMIT 1`, [String(siteId)]))?.[0]
  if (site?.owner_id != null && Number(site.owner_id) === targetId)
    return json({ error: 'The owner cannot be removed' }, 409)

  await pgq(`DELETE FROM site_members WHERE site_id = ? AND user_id = ?`, [String(siteId), targetId])
  return json({ members: await listSiteMembers(siteId) })
}).middleware('auth').skipCsrf()

route.post('/api/sites', async (request: any) => {
  const uid = authUserId(request)
  if (!uid)
    return json({ error: 'Unauthorized' }, 401)

  const body = request.jsonBody ?? {}
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : ''
  const domain = typeof body.domain === 'string' ? body.domain.trim().slice(0, 255) : ''
  if (!name)
    return json({ error: 'name is required' }, 400)

  // Unguessable, server-minted id — never trust a caller-supplied one (that would
  // reopen the land-grab of a live public site-id).
  const id = createHash('sha256').update(`${uid}|${name}|${randomId()}|${Date.now()}`).digest('hex').slice(0, 24)
  const now = new Date().toISOString()
  const domains = domain ? [domain] : []

  await db.insertInto('sites').values({
    id,
    name,
    domains: JSON.stringify(domains),
    timezone: 'UTC',
    is_active: true,
    owner_id: Number(uid),
    settings: '{}',
    created_at: now,
    updated_at: now,
  }).execute()

  return json({ site: { id, name, domains, owner_id: Number(uid) } }, 201)
}).middleware('auth').skipCsrf()

/** True when `tz` is an IANA time zone the runtime accepts (for per-site tz). */
function isValidTimeZone(tz: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  }
  catch {
    return false
  }
}

route.options('/api/sites/{siteId}', () => new Response(null, { status: 204, headers: CORS }))

// Rename / edit a site (name, domains, timezone). Owner-scoped, partial update.
route.patch('/api/sites/{siteId}', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const body = request.jsonBody ?? {}
  const sets: string[] = []
  const params: unknown[] = []

  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 255)
    if (!name)
      return json({ error: 'name cannot be empty' }, 400)
    sets.push('name = ?')
    params.push(name)
  }
  if (Array.isArray(body.domains)) {
    const domains = body.domains
      .filter((d: unknown): d is string => typeof d === 'string')
      .map((d: string) => d.trim().slice(0, 255))
      .filter(Boolean)
    sets.push('domains = ?')
    params.push(JSON.stringify(domains))
  }
  if (typeof body.timezone === 'string') {
    if (!isValidTimeZone(body.timezone))
      return json({ error: 'invalid timezone' }, 400)
    sets.push('timezone = ?')
    params.push(body.timezone)
  }
  // Default currency for revenue events that arrive without one (#22). Empty
  // string clears it, which is not the same as omitting the field: omitting means
  // "leave it alone", and without the distinction there is no way to unset it.
  if (body.currency !== undefined) {
    if (body.currency === null || body.currency === '') {
      sets.push('currency = ?')
      params.push(null)
    }
    else {
      const currency = normalizeCurrency(body.currency)
      if (!currency)
        return json({ error: 'currency must be a 3-letter ISO 4217 code' }, 400)
      sets.push('currency = ?')
      params.push(currency)
    }
  }
  // Email digest opt-in (#14). Read by app/Jobs/SendAnalyticsDigest.ts.
  //
  // It rides in `settings` rather than a column of its own, the way share_token
  // does, so adding a preference needs no migration. 'off' DELETES the key rather
  // than storing a falsy value: absent is what the job treats as off, so one
  // spelling of "no mail" cannot disagree with another.
  //
  // Read-modify-write on a JSON blob is last-write-wins against a concurrent
  // share-token rotation. Both are owner-only, deliberate, single-user actions, so
  // the race needs two tabs and a coincidence; a jsonb column would be the real
  // answer if this column ever gets a third writer.
  if (typeof body.digest === 'string') {
    const value = body.digest.trim().toLowerCase()
    if (!['weekly', 'monthly', 'off'].includes(value))
      return json({ error: 'digest must be weekly, monthly or off' }, 400)
    const settings = await readSiteSettings(siteId)
    if (value === 'off')
      delete settings.digest
    else settings.digest = value
    sets.push('settings = ?')
    params.push(JSON.stringify(settings))
  }

  if (!sets.length)
    return json({ error: 'nothing to update' }, 400)

  sets.push('updated_at = ?')
  params.push(new Date().toISOString())
  params.push(String(siteId))
  await pgq(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`, params)
  const rows = await pgq(`SELECT id, name, domains, timezone, is_active FROM sites WHERE id = ? LIMIT 1`, [String(siteId)])
  return json({ site: rows?.[0] ?? null })
}).middleware('auth').skipCsrf()

// Delete a site and cascade-erase all of its data (events + goals + the row).
route.delete('/api/sites/{siteId}', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const deleted = await eraseRows(siteId)
  const goals = await pgq(`DELETE FROM goals WHERE site_id = ? RETURNING 1`, [String(siteId)])
  deleted.goals = Array.isArray(goals) ? goals.length : 0
  await pgq(`DELETE FROM sites WHERE id = ?`, [String(siteId)])
  return json({ ok: true, deleted })
}).middleware('auth').skipCsrf()

// ---------------------------------------------------------------------------
// Goals (management API)
// ---------------------------------------------------------------------------

const GOAL_TYPES = new Set(['pageview', 'event'])
const GOAL_MATCH_TYPES = new Set(['exact', 'contains', 'starts_with'])

route.options('/api/sites/{siteId}/goals', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/goals', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const rows = await pgq(
    `SELECT id, site_id, name, type, pattern, match_type, value, default_amount_minor, currency, is_active
    FROM goals WHERE site_id = ? ORDER BY created_at DESC`,
    [siteId],
  )
  return json({ goals: rows ?? [] })
}).middleware('auth')

route.post('/api/sites/{siteId}/goals', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  const body = request.jsonBody ?? {}
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : ''
  const type = String(body.type ?? '')
  const pattern = typeof body.pattern === 'string' ? body.pattern.trim().slice(0, 255) : ''
  const matchType = String(body.match_type ?? 'exact')
  const value = body.value == null || body.value === '' ? null : Number(body.value)

  if (!name)
    return json({ error: 'name is required' }, 400)
  if (!GOAL_TYPES.has(type))
    return json({ error: 'type must be pageview or event' }, 400)
  if (!GOAL_MATCH_TYPES.has(matchType))
    return json({ error: 'match_type must be exact, contains, or starts_with' }, 400)
  if (!pattern)
    return json({ error: 'pattern is required' }, 400)
  if (value != null && !Number.isFinite(value))
    return json({ error: 'value must be a finite number' }, 400)

  // Revenue default (#22). Stored as minor units so nothing downstream has to
  // guess whether "50" meant dollars or cents — the ambiguity the legacy `value`
  // column above still carries, and the reason it is left alone rather than
  // reinterpreted.
  const currency = body.currency == null || body.currency === '' ? null : normalizeCurrency(body.currency)
  if (body.currency != null && body.currency !== '' && !currency)
    return json({ error: 'currency must be a 3-letter ISO 4217 code' }, 400)

  let defaultAmountMinor: number | null = null
  if (body.default_amount != null && body.default_amount !== '') {
    if (!currency)
      return json({ error: 'a default_amount needs a currency' }, 400)
    defaultAmountMinor = toMinorUnits(body.default_amount, currency)
    if (defaultAmountMinor == null)
      return json({ error: 'default_amount is not a valid amount' }, 400)
  }

  // Cap active goals per site to bound the /collect matching loop (defense-in-depth).
  const activeCount = (await pgq(`SELECT COUNT(*) AS n FROM goals WHERE site_id = ? AND is_active = true`, [String(siteId)]))?.[0]?.n
  if (Number(activeCount ?? 0) >= 50)
    return json({ error: 'active goal limit reached (50)' }, 409)

  // The ownership guard already proved the site row exists (and is ours), so the
  // goals.site_id FK is satisfied without a self-register here.
  const id = randomId()
  await db.insertInto('goals').values({
    id,
    site_id: String(siteId),
    name,
    type,
    pattern,
    match_type: matchType,
    value,
    default_amount_minor: defaultAmountMinor,
    currency,
    is_active: true,
  }).execute()

  return json({
    goal: {
      id,
      site_id: String(siteId),
      name,
      type,
      pattern,
      match_type: matchType,
      value,
      currency,
      default_amount_minor: defaultAmountMinor,
      default_amount: defaultAmountMinor == null || !currency ? null : formatMinor(defaultAmountMinor, currency),
      is_active: true,
    },
  }, 201)
})
  // Management endpoint: authenticated (bearer token — CSRF-immune) AND scoped to
  // the site's owner via requireSiteOwner() in the handler.
  .middleware('auth')
  .skipCsrf()

route.options('/api/sites/{siteId}/goals/{goalId}', () => new Response(null, { status: 204, headers: CORS }))

route.delete('/api/sites/{siteId}/goals/{goalId}', async (request: any) => {
  const siteId = request.params.siteId
  const goalId = request.params.goalId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  // Delete the goal's conversions first — conversions.goal_id FKs to goals.id, so
  // dropping the goal while conversions reference it would fail the constraint.
  await pgq(`DELETE FROM conversions WHERE site_id = ? AND goal_id = ?`, [String(siteId), String(goalId)]).catch(() => {})
  await pgq(`DELETE FROM goals WHERE site_id = ? AND id = ?`, [String(siteId), String(goalId)])
  return json({ ok: true })
})
  // Same posture as create: authenticated + owner-scoped (requireSiteOwner).
  .middleware('auth')
  .skipCsrf()

// ---------------------------------------------------------------------------
// Alerts (#24)
// ---------------------------------------------------------------------------
// Every endpoint here is ADMIN, including the list — unlike goals or members,
// where reading is a viewer right. An alert's `channels` holds delivery secrets:
// a Slack incoming-webhook URL is a bearer credential, and anyone holding one can
// post into that channel as the app forever. A viewer is someone trusted to read
// a site's numbers, which is not the same as being trusted with the owner's Slack.
//
// Evaluation lives in app/Analytics/alerts.ts and delivery in app/Alerts/. These
// endpoints only validate and store.

/** Bound the hourly job's work: each alert costs 1 + baseline_days queries a run. */
const ALERT_LIMIT_PER_SITE = 20

const ALERT_BOUNDS = {
  window_minutes: { min: 5, max: 1440, fallback: 60 },
  baseline_days: { min: 1, max: 30, fallback: 7 },
  min_volume: { min: 0, max: 1_000_000, fallback: 20 },
  cooldown_minutes: { min: 0, max: 43_200, fallback: 1440 },
} as const

function boundedInt(value: unknown, bound: { min: number, max: number, fallback: number }): number | null {
  if (value == null || value === '')
    return bound.fallback
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < bound.min || n > bound.max)
    return null
  return n
}

/**
 * Validate a channel list, resolving each webhook URL.
 *
 * URLs are checked here so a typo is refused while the person is looking at the
 * form, but this is not the check that protects the server — `postJson` runs the
 * same guard immediately before every request, because DNS can change after a URL
 * is stored. See app/Alerts/url-safety.ts.
 */
async function validateChannels(raw: unknown): Promise<{ error: string } | { channels: any[] }> {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: 'at least one channel is required' }
  if (raw.length > 10)
    return { error: 'a maximum of 10 channels is allowed' }

  const channels: any[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object')
      return { error: 'each channel must be an object' }
    const { type, to, url } = entry as Record<string, unknown>

    if (type === 'email') {
      const address = typeof to === 'string' ? to.trim() : ''
      if (!address.includes('@'))
        return { error: 'email channels need a `to` address' }
      channels.push({ type: 'email', to: address.slice(0, 255) })
      continue
    }

    if (type === 'slack' || type === 'webhook') {
      const target = typeof url === 'string' ? url.trim() : ''
      if (!target)
        return { error: `${type} channels need a \`url\`` }
      const verdict = await checkWebhookUrl(target)
      if (!verdict.ok)
        return { error: verdict.reason || 'that webhook URL was refused' }
      channels.push({ type, url: target.slice(0, 2048) })
      continue
    }

    return { error: 'channel type must be email, slack, or webhook' }
  }
  return { channels }
}

/** Shape one row for the API, parsing `channels` so clients do not double-decode. */
function alertOut(row: any): Record<string, unknown> {
  let channels: unknown = []
  try {
    channels = JSON.parse(row.channels || '[]')
  }
  catch {
    channels = []
  }
  return {
    id: row.id,
    site_id: row.site_id,
    name: row.name,
    metric: row.metric,
    goal_id: row.goal_id ?? null,
    condition: row.condition,
    threshold: Number(row.threshold),
    window_minutes: Number(row.window_minutes),
    baseline_days: Number(row.baseline_days),
    min_volume: Number(row.min_volume),
    cooldown_minutes: Number(row.cooldown_minutes),
    is_active: !!row.is_active,
    last_fired_at: row.last_fired_at ?? null,
    created_at: row.created_at,
    channels,
  }
}

route.options('/api/sites/{siteId}/alerts', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/alerts', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  const rows = await pgq(
    `SELECT * FROM site_alerts WHERE site_id = ? ORDER BY created_at DESC`,
    [String(siteId)],
  )
  return json({ alerts: (rows ?? []).map(alertOut) })
}).middleware('auth')

route.post('/api/sites/{siteId}/alerts', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const body = request.jsonBody ?? {}
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : ''
  const metric = body.metric
  const condition = body.condition
  const threshold = Number(body.threshold)

  if (!name)
    return json({ error: 'name is required' }, 400)
  if (!isAlertMetric(metric))
    return json({ error: `metric must be one of ${ALERT_METRICS.join(', ')}` }, 400)
  if (!isAlertCondition(condition))
    return json({ error: `condition must be one of ${ALERT_CONDITIONS.join(', ')}` }, 400)
  if (!Number.isFinite(threshold))
    return json({ error: 'threshold must be a finite number' }, 400)
  // A spike or drop threshold of zero or less fires on every run by definition —
  // "notify me when traffic changes by at least nothing".
  if (isRelative(condition) && threshold <= 0)
    return json({ error: 'a spike or drop threshold must be a positive percentage' }, 400)
  if (!isRelative(condition) && threshold < 0)
    return json({ error: 'threshold must not be negative' }, 400)

  const windowMinutes = boundedInt(body.window_minutes, ALERT_BOUNDS.window_minutes)
  if (windowMinutes === null)
    return json({ error: 'window_minutes must be between 5 and 1440' }, 400)
  const baselineDays = boundedInt(body.baseline_days, ALERT_BOUNDS.baseline_days)
  if (baselineDays === null)
    return json({ error: 'baseline_days must be between 1 and 30' }, 400)
  const minVolume = boundedInt(body.min_volume, ALERT_BOUNDS.min_volume)
  if (minVolume === null)
    return json({ error: 'min_volume must be a non-negative integer' }, 400)
  const cooldown = boundedInt(body.cooldown_minutes, ALERT_BOUNDS.cooldown_minutes)
  if (cooldown === null)
    return json({ error: 'cooldown_minutes must be between 0 and 43200' }, 400)

  // A goal id only means something for conversions, and it must belong to THIS
  // site — otherwise an admin on one site could point an alert at another site's
  // goal and read its conversion counts out of the notifications.
  let goalId: string | null = null
  if (metric === 'conversions' && body.goal_id) {
    goalId = String(body.goal_id)
    const owned = (await pgq(`SELECT 1 FROM goals WHERE id = ? AND site_id = ? LIMIT 1`, [goalId, String(siteId)]))?.[0]
    if (!owned)
      return json({ error: 'That goal does not belong to this site' }, 404)
  }

  const validated = await validateChannels(body.channels)
  if ('error' in validated)
    return json({ error: validated.error }, 400)

  const count = (await pgq(`SELECT COUNT(*) AS n FROM site_alerts WHERE site_id = ?`, [String(siteId)]))?.[0]?.n
  if (Number(count ?? 0) >= ALERT_LIMIT_PER_SITE)
    return json({ error: `alert limit reached (${ALERT_LIMIT_PER_SITE})` }, 409)

  const id = randomId()
  const now = new Date().toISOString()
  await pgq(
    `INSERT INTO site_alerts
       (id, site_id, name, metric, goal_id, condition, threshold, window_minutes, baseline_days, min_volume, cooldown_minutes, channels, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, String(siteId), name, metric, goalId, condition, threshold, windowMinutes, baselineDays, minVolume, cooldown, JSON.stringify(validated.channels), true, now],
  )

  const row = (await pgq(`SELECT * FROM site_alerts WHERE id = ?`, [id]))?.[0]
  return json({ alert: alertOut(row) }, 201)
}).middleware('auth').skipCsrf()

route.options('/api/sites/{siteId}/alerts/{alertId}', () => new Response(null, { status: 204, headers: CORS }))

route.patch('/api/sites/{siteId}/alerts/{alertId}', async (request: any) => {
  const siteId = request.params.siteId
  const alertId = request.params.alertId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  // Scoped by BOTH ids: an alert id from another site must not be reachable by an
  // admin who happens to hold one here.
  const existing = (await pgq(`SELECT * FROM site_alerts WHERE id = ? AND site_id = ? LIMIT 1`, [String(alertId), String(siteId)]))?.[0]
  if (!existing)
    return json({ error: 'Alert not found' }, 404)

  const body = request.jsonBody ?? {}
  const updates: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : ''
    if (!name)
      return json({ error: 'name cannot be empty' }, 400)
    updates.name = name
  }

  if (body.is_active !== undefined)
    updates.is_active = !!body.is_active

  if (body.threshold !== undefined) {
    const threshold = Number(body.threshold)
    const condition = (body.condition ?? existing.condition) as string
    if (!Number.isFinite(threshold))
      return json({ error: 'threshold must be a finite number' }, 400)
    if (isAlertCondition(condition) && isRelative(condition) && threshold <= 0)
      return json({ error: 'a spike or drop threshold must be a positive percentage' }, 400)
    updates.threshold = threshold
  }

  if (body.condition !== undefined) {
    if (!isAlertCondition(body.condition))
      return json({ error: `condition must be one of ${ALERT_CONDITIONS.join(', ')}` }, 400)
    updates.condition = body.condition
  }

  if (body.metric !== undefined) {
    if (!isAlertMetric(body.metric))
      return json({ error: `metric must be one of ${ALERT_METRICS.join(', ')}` }, 400)
    updates.metric = body.metric
  }

  for (const key of ['window_minutes', 'baseline_days', 'min_volume', 'cooldown_minutes'] as const) {
    if (body[key] === undefined)
      continue
    const value = boundedInt(body[key], ALERT_BOUNDS[key])
    if (value === null)
      return json({ error: `${key} is out of range` }, 400)
    updates[key] = value
  }

  if (body.channels !== undefined) {
    const validated = await validateChannels(body.channels)
    if ('error' in validated)
      return json({ error: validated.error }, 400)
    updates.channels = JSON.stringify(validated.channels)
  }

  // Re-enabling or retuning an alert clears the quiet period. Otherwise an alert
  // switched off during an incident and back on afterwards stays silent for the
  // rest of its cooldown, which is precisely when it is wanted.
  if (updates.is_active === true || updates.channels !== undefined || updates.threshold !== undefined)
    updates.last_fired_at = null

  if (!Object.keys(updates).length)
    return json({ error: 'nothing to update' }, 400)

  updates.updated_at = new Date().toISOString()

  // Column names come from the fixed list above, never from the request body, so
  // this interpolation cannot be steered by a caller.
  const columns = Object.keys(updates)
  await pgq(
    `UPDATE site_alerts SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND site_id = ?`,
    [...columns.map(c => updates[c]), String(alertId), String(siteId)],
  )

  const row = (await pgq(`SELECT * FROM site_alerts WHERE id = ?`, [String(alertId)]))?.[0]
  return json({ alert: alertOut(row) })
}).middleware('auth').skipCsrf()

route.delete('/api/sites/{siteId}/alerts/{alertId}', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  await pgq(`DELETE FROM site_alerts WHERE id = ? AND site_id = ?`, [String(request.params.alertId), String(siteId)])
  return json({ ok: true })
}).middleware('auth').skipCsrf()

// ---------------------------------------------------------------------------
// Funnels (#21)
// ---------------------------------------------------------------------------
// Reading is a VIEWER right, unlike alerts. A funnel definition is a list of goal
// ids and a name — it holds no delivery credential, and its results are the same
// aggregate numbers a viewer can already reach through the goals report. Writing
// is admin, matching goals.
//
// Results are counts and nothing else. See app/Analytics/funnels.ts: no identity
// leaves the query, so "aggregate only" is a property of the SQL rather than a
// rule someone has to remember.

/** Resolve step labels, and confirm every step is a goal on THIS site. */
async function funnelGoalNames(siteId: string, steps: string[]): Promise<Record<string, string>> {
  if (!steps.length)
    return {}
  const placeholders = steps.map(() => '?').join(', ')
  const rows = await pgq(
    `SELECT id, name FROM goals WHERE site_id = ? AND id IN (${placeholders})`,
    [String(siteId), ...steps],
  )
  const names: Record<string, string> = {}
  for (const row of (rows ?? []) as Array<{ id: string, name: string }>)
    names[String(row.id)] = String(row.name)
  return names
}

function funnelOut(row: any): Record<string, unknown> {
  return {
    id: row.id,
    site_id: row.site_id,
    name: row.name,
    scope: row.scope,
    steps: parseSteps(row.steps),
    created_at: row.created_at,
  }
}

route.options('/api/sites/{siteId}/funnels', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/funnels', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const rows = await pgq(`SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at DESC`, [String(siteId)])
  return json({ funnels: (rows ?? []).map(funnelOut) })
}).middleware('auth')

route.post('/api/sites/{siteId}/funnels', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const body = request.jsonBody ?? {}
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : ''
  const scope = body.scope ?? 'session'

  if (!name)
    return json({ error: 'name is required' }, 400)
  if (!isFunnelScope(scope))
    return json({ error: `scope must be one of ${FUNNEL_SCOPES.join(', ')}` }, 400)

  const validated = validateSteps(body.steps)
  if ('error' in validated)
    return json({ error: validated.error }, 400)

  // Every step must be a goal on THIS site. Without this an admin on one site
  // could name another site's goal and read its conversion counts out of the
  // funnel — the same cross-site leak the alerts endpoint closes for goal_id.
  const names = await funnelGoalNames(siteId, validated.steps)
  const missing = validated.steps.filter(id => !(id in names))
  if (missing.length)
    return json({ error: `these steps are not goals on this site: ${missing.join(', ')}` }, 404)

  const count = (await pgq(`SELECT COUNT(*) AS n FROM funnels WHERE site_id = ?`, [String(siteId)]))?.[0]?.n
  if (Number(count ?? 0) >= 20)
    return json({ error: 'funnel limit reached (20)' }, 409)

  const id = randomId()
  const now = new Date().toISOString()
  await pgq(
    `INSERT INTO funnels (id, site_id, name, steps, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, String(siteId), name, JSON.stringify(validated.steps), scope, now],
  )
  const row = (await pgq(`SELECT * FROM funnels WHERE id = ?`, [id]))?.[0]
  return json({ funnel: funnelOut(row) }, 201)
}).middleware('auth').skipCsrf()

route.options('/api/sites/{siteId}/funnels/{funnelId}', () => new Response(null, { status: 204, headers: CORS }))

route.patch('/api/sites/{siteId}/funnels/{funnelId}', async (request: any) => {
  const siteId = request.params.siteId
  const funnelId = request.params.funnelId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  // Scoped by both ids, so a funnel id from another site is not reachable.
  const existing = (await pgq(`SELECT * FROM funnels WHERE id = ? AND site_id = ? LIMIT 1`, [String(funnelId), String(siteId)]))?.[0]
  if (!existing)
    return json({ error: 'Funnel not found' }, 404)

  const body = request.jsonBody ?? {}
  const updates: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : ''
    if (!name)
      return json({ error: 'name cannot be empty' }, 400)
    updates.name = name
  }

  if (body.scope !== undefined) {
    if (!isFunnelScope(body.scope))
      return json({ error: `scope must be one of ${FUNNEL_SCOPES.join(', ')}` }, 400)
    updates.scope = body.scope
  }

  if (body.steps !== undefined) {
    const validated = validateSteps(body.steps)
    if ('error' in validated)
      return json({ error: validated.error }, 400)
    const names = await funnelGoalNames(siteId, validated.steps)
    const missing = validated.steps.filter(id => !(id in names))
    if (missing.length)
      return json({ error: `these steps are not goals on this site: ${missing.join(', ')}` }, 404)
    updates.steps = JSON.stringify(validated.steps)
  }

  if (!Object.keys(updates).length)
    return json({ error: 'nothing to update' }, 400)

  updates.updated_at = new Date().toISOString()

  // Column names come from the fixed set above, never the request body.
  const columns = Object.keys(updates)
  await pgq(
    `UPDATE funnels SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND site_id = ?`,
    [...columns.map(c => updates[c]), String(funnelId), String(siteId)],
  )
  const row = (await pgq(`SELECT * FROM funnels WHERE id = ?`, [String(funnelId)]))?.[0]
  return json({ funnel: funnelOut(row) })
}).middleware('auth').skipCsrf()

route.delete('/api/sites/{siteId}/funnels/{funnelId}', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  await pgq(`DELETE FROM funnels WHERE id = ? AND site_id = ?`, [String(request.params.funnelId), String(siteId)])
  return json({ ok: true })
}).middleware('auth').skipCsrf()

route.options('/api/sites/{siteId}/funnels/{funnelId}/results', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/funnels/{funnelId}/results', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied

  const row = (await pgq(`SELECT * FROM funnels WHERE id = ? AND site_id = ? LIMIT 1`, [String(request.params.funnelId), String(siteId)]))?.[0]
  if (!row)
    return json({ error: 'Funnel not found' }, 404)

  const steps = parseSteps(row.steps)
  if (steps.length < 2)
    return json({ error: 'This funnel no longer has enough steps' }, 409)

  const url = new URL(request.url)
  const to = url.searchParams.get('endDate') ? new Date(`${url.searchParams.get('endDate')}T23:59:59.999Z`) : new Date()
  const from = url.searchParams.get('startDate')
    ? new Date(`${url.searchParams.get('startDate')}T00:00:00.000Z`)
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()))
    return json({ error: 'startDate and endDate must be YYYY-MM-DD' }, 400)

  const names = await funnelGoalNames(siteId, steps)
  const result = await computeFunnel(String(siteId), steps, row.scope === 'day' ? 'day' : 'session', from, to, names)

  return json({ funnel: funnelOut(row), result })
}).middleware('auth')

// ---------------------------------------------------------------------------
// First-party CNAME proxying (#27)
// ---------------------------------------------------------------------------
// A customer points stats.their-site.com at us and the tracker loads from there,
// so a content blocker sees a subdomain of the site being visited rather than a
// known analytics vendor.
//
// The client half already worked: public/script.js derives its collect origin
// from its own script src, so the same asset beacons back to whichever host
// served it. What is added here is the server knowing which hostnames it has
// agreed to answer for, and proof the customer controls them.
//
// Verification is not optional. The deployment issues a TLS certificate per
// accepted domain, so an unverified field is a way to make this service request
// certificates for domains it has no relationship with — and without it one
// customer could claim a hostname belonging to someone else.
//
// TLS termination and edge routing for the customer's hostname are DEPLOYMENT
// work and are not done here. This decides whether a domain is claimable and
// whether DNS agrees; acting on that is the platform's job.

/** The host a customer points their CNAME at. */
function cnameTarget(): string {
  const configured = process.env.ANALYTICSHQ_CNAME_TARGET
  if (configured && configured.trim())
    return configured.trim().toLowerCase()
  try {
    return new URL(config.app?.url || 'https://analyticshq.org').hostname.toLowerCase()
  }
  catch {
    return 'analyticshq.org'
  }
}

route.options('/api/sites/{siteId}/domain', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/domain', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied

  const row = (await pgq(`SELECT custom_domain, custom_domain_verified_at FROM sites WHERE id = ? LIMIT 1`, [String(siteId)]))?.[0]
  const appUrl = config.app?.url || 'https://analyticshq.org'

  return json({
    domain: row?.custom_domain ?? null,
    verified: !!row?.custom_domain_verified_at,
    verified_at: row?.custom_domain_verified_at ?? null,
    cname_target: cnameTarget(),
    snippet: snippetFor(String(siteId), appUrl, row?.custom_domain ?? null, row?.custom_domain_verified_at ?? null),
  })
}).middleware('auth')

route.post('/api/sites/{siteId}/domain', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const shape = checkDomainShape(request.jsonBody?.domain, cnameTarget())
  if (!shape.ok || !shape.domain)
    return json({ error: shape.reason ?? 'That is not a valid hostname.' }, 400)

  // Claimed by another site is a 409 rather than a silent overwrite: two sites on
  // one hostname would interleave their data with no way to separate it after.
  const taken = (await pgq(`SELECT id FROM sites WHERE custom_domain = ? AND id <> ? LIMIT 1`, [shape.domain, String(siteId)]))?.[0]
  if (taken)
    return json({ error: 'That hostname is already in use by another site.' }, 409)

  // Stored unverified. Re-declaring an already-verified domain resets that, so a
  // domain cannot stay marked verified after being pointed somewhere else.
  await pgq(
    `UPDATE sites SET custom_domain = ?, custom_domain_verified_at = NULL WHERE id = ?`,
    [shape.domain, String(siteId)],
  )

  return json({
    domain: shape.domain,
    verified: false,
    cname_target: cnameTarget(),
    instructions: `Create a CNAME record for ${shape.domain} pointing to ${cnameTarget()}, then verify.`,
  }, 201)
}).middleware('auth').skipCsrf()

route.options('/api/sites/{siteId}/domain/verify', () => new Response(null, { status: 204, headers: CORS }))

route.post('/api/sites/{siteId}/domain/verify', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const row = (await pgq(`SELECT custom_domain FROM sites WHERE id = ? LIMIT 1`, [String(siteId)]))?.[0]
  const domain = row?.custom_domain
  if (!domain)
    return json({ error: 'No custom domain has been declared for this site.' }, 404)

  const verdict = await verifyDomainDns(String(domain), cnameTarget())
  if (!verdict.ok) {
    // Left declared but unverified, so the customer can fix DNS and retry without
    // retyping — and so nothing starts trusting it in the meantime.
    return json({ domain, verified: false, error: verdict.reason }, 422)
  }

  const now = new Date().toISOString()
  await pgq(`UPDATE sites SET custom_domain_verified_at = ? WHERE id = ?`, [now, String(siteId)])

  const appUrl = config.app?.url || 'https://analyticshq.org'
  return json({
    domain,
    verified: true,
    verified_at: now,
    snippet: snippetFor(String(siteId), appUrl, String(domain), now),
    note: 'DNS is correct. Serving over this hostname also requires a TLS certificate for it, which is provisioned by the deployment.',
  })
}).middleware('auth').skipCsrf()

route.delete('/api/sites/{siteId}/domain', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  await pgq(`UPDATE sites SET custom_domain = NULL, custom_domain_verified_at = NULL WHERE id = ?`, [String(siteId)])
  return json({ ok: true })
}).middleware('auth').skipCsrf()

// ---------------------------------------------------------------------------
// Embeddable public widgets (#26)
// ---------------------------------------------------------------------------
// A badge or sparkline served to an <img>/<iframe> on somebody else's page, so
// these are the only routes here without `.middleware('auth')` besides /collect.
//
// TWO DECISIONS THAT ARE THE WHOLE SECURITY OF THIS FEATURE
//
// 1. The widget token is NOT the dashboard share token. A badge lives in an
//    <img src> in public page source, so its token is public by construction.
//    Reusing `share_token` would mean that embedding a visitor count silently
//    publishes the entire dashboard — every path, referrer and country — to
//    anyone who views source. They are minted, rotated and revoked separately,
//    and holding one grants nothing about the other.
//
// 2. A widget exposes TOTALS AND A DAILY SERIES, and no dimensions. Top paths on
//    a public endpoint leak internal and unreleased URLs: /admin/project-titan,
//    /blog/the-post-we-have-not-announced. There is no filter parameter either,
//    which is also what keeps a public surface clear of the re-identification
//    problem that segmenting an aggregate down to one person would create.
//
// Both are enforced below and asserted in tests/unit/widgets.test.ts.

/** Compare two secrets without leaking their contents through timing. */
function tokensMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b)
    return false
  // Hashed first so the buffers are always the same length — timingSafeEqual
  // throws on a length mismatch, and catching that would itself be a length
  // oracle.
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

/** Resolve a widget request, or the reason it was refused. */
async function widgetSite(request: any): Promise<{ siteId: string, settings: Record<string, any> } | null> {
  const siteId = String(request.params.siteId ?? '')
  const token = request.query?.token
  if (!siteId || typeof token !== 'string')
    return null
  const settings = await readSiteSettings(siteId)
  if (!tokensMatch(settings.widget_token, token))
    return null
  return { siteId, settings }
}

/** Public widget responses are cacheable — a badge on a busy page is hammered. */
const WIDGET_CACHE = 'public, max-age=300, s-maxage=300'

/** Days a widget may look back. Bounded so a public endpoint cannot ask for everything. */
function widgetWindow(request: any): { from: string, to: string, days: number } {
  const raw = Number(request.query?.days ?? 30)
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.trunc(raw))) : 30
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString(), days }
}

route.options('/api/sites/{siteId}/widget', () => new Response(null, { status: 204, headers: CORS }))

route.post('/api/sites/{siteId}/widget', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  // Rotate on every POST, like the share token: a fresh value invalidates every
  // badge already embedded, which is the only way to withdraw one.
  const token = createHash('sha256').update(`${siteId}|${randomId()}|widget`).digest('hex').slice(0, 32)
  const settings = await readSiteSettings(siteId)
  settings.widget_token = token
  await pgq(`UPDATE sites SET settings = ? WHERE id = ?`, [JSON.stringify(settings), String(siteId)])
  const base = config.app?.url || ''
  return json({
    token,
    badge: `${base}/public/${encodeURIComponent(String(siteId))}/badge.svg?token=${token}`,
    summary: `${base}/api/public/${encodeURIComponent(String(siteId))}/summary?token=${token}`,
    embed: `<img src="${base}/public/${encodeURIComponent(String(siteId))}/badge.svg?token=${token}" alt="visitors" />`,
  })
}).middleware('auth').skipCsrf()

route.delete('/api/sites/{siteId}/widget', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  const settings = await readSiteSettings(siteId)
  delete settings.widget_token
  await pgq(`UPDATE sites SET settings = ? WHERE id = ?`, [JSON.stringify(settings), String(siteId)])
  return json({ ok: true })
}).middleware('auth').skipCsrf()

/**
 * Totals and a daily series for one site. Public, token-gated.
 *
 * Deliberately no dimensions and no filters — see the section header.
 */
route.options('/api/public/{siteId}/summary', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/public/{siteId}/summary', async (request: any) => {
  const site = await widgetSite(request)
  // One answer for "no such site", "no widget token" and "wrong token". A public
  // endpoint that distinguishes them turns a site id — which is public — into a
  // way to enumerate which sites have widgets enabled.
  if (!site)
    return json({ error: 'Not found' }, 404)

  const { from, to, days } = widgetWindow(request)

  const totals = (await pgq(
    `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
     FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?`,
    [site.siteId, from, to],
  ))?.[0]

  const series = await pgq(
    `SELECT LEFT(timestamp, 10) AS day, COUNT(DISTINCT visitor_id) AS visitors
     FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?
     GROUP BY LEFT(timestamp, 10) ORDER BY day ASC`,
    [site.siteId, from, to],
  )

  return new Response(JSON.stringify({
    days,
    visitors: Number(totals?.visitors ?? 0),
    views: Number(totals?.views ?? 0),
    series: (series ?? []).map((r: any) => ({ day: r.day, visitors: Number(r.visitors ?? 0) })),
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': WIDGET_CACHE, ...CORS },
  })
})

/** The badge itself. Served as an image, so no CORS dance and no script. */
route.get('/public/{siteId}/badge.svg', async (request: any) => {
  const site = await widgetSite(request)
  if (!site) {
    // An SVG, not a 404 page: this is loaded by <img>, and a broken image tells
    // whoever embedded it nothing. A badge that says so is debuggable.
    return new Response(renderBadge({ label: 'visitors', value: 'n/a', color: '#8b8b8b' }), {
      status: 404,
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', ...CORS },
    })
  }

  const { from, to } = widgetWindow(request)
  const metric = request.query?.metric === 'views' ? 'views' : 'visitors'

  const row = (await pgq(
    `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
     FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?`,
    [site.siteId, from, to],
  ))?.[0]

  const svg = renderBadge({
    label: sanitizeLabel(request.query?.label, metric),
    value: formatCount(Number(row?.[metric] ?? 0)),
    color: typeof request.query?.color === 'string' ? request.query.color : undefined,
  })

  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': WIDGET_CACHE, ...CORS },
  })
})

/** A standalone sparkline, for embedding next to the badge. */
route.get('/public/{siteId}/sparkline.svg', async (request: any) => {
  const site = await widgetSite(request)
  if (!site) {
    return new Response(renderSparkline([]), {
      status: 404,
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', ...CORS },
    })
  }

  const { from, to } = widgetWindow(request)
  const rows = await pgq(
    `SELECT LEFT(timestamp, 10) AS day, COUNT(DISTINCT visitor_id) AS visitors
     FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?
     GROUP BY LEFT(timestamp, 10) ORDER BY day ASC`,
    [site.siteId, from, to],
  )

  return new Response(renderSparkline((rows ?? []).map((r: any) => Number(r.visitors ?? 0))), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': WIDGET_CACHE, ...CORS },
  })
})

// ---------------------------------------------------------------------------
// Revenue (#22)
// ---------------------------------------------------------------------------
// Totals are reported PER CURRENCY and never summed across them. Adding dollars
// to euros needs an exchange rate, and picking one to produce a single headline
// number would be inventing the figure — at whatever rate happened to apply on
// whatever day, silently, in a number the customer would reconcile against their
// own books. A site selling in one currency sees one row, which is the common
// case and reads no worse for being a list.
//
// Amounts are whole minor units (cents, yen) throughout. `amount` is the decimal
// rendering, as a STRING, because handing back 19.99 as a float reintroduces the
// representation problem the integer storage exists to avoid.

route.options('/api/sites/{siteId}/revenue', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/revenue', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)

  // NULL currency rows are excluded rather than bucketed: a conversion with an
  // amount but no currency is a number nobody can interpret, and showing it under
  // a blank heading invites it to be read as the site's default.
  const byCurrency = await pgq(
    `SELECT currency, SUM(amount_minor) AS amount_minor, COUNT(*) AS conversions
     FROM conversions
     WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?
       AND amount_minor IS NOT NULL AND currency IS NOT NULL
     GROUP BY currency ORDER BY SUM(amount_minor) DESC`,
    [String(siteId), from, to],
  )

  const byGoal = await pgq(
    `SELECT c.goal_id, g.name, c.currency, SUM(c.amount_minor) AS amount_minor, COUNT(*) AS conversions
     FROM conversions c LEFT JOIN goals g ON g.id = c.goal_id
     WHERE c.site_id = ? AND c.timestamp >= ? AND c.timestamp <= ?
       AND c.amount_minor IS NOT NULL AND c.currency IS NOT NULL
     GROUP BY c.goal_id, g.name, c.currency ORDER BY SUM(c.amount_minor) DESC LIMIT 50`,
    [String(siteId), from, to],
  )

  const shape = (row: any) => ({
    currency: String(row.currency),
    amountMinor: Number(row.amount_minor ?? 0),
    amount: formatMinor(Number(row.amount_minor ?? 0), String(row.currency)),
    conversions: Number(row.conversions ?? 0),
  })

  return json({
    range: { from, to },
    currencies: (byCurrency ?? []).map(shape),
    goals: (byGoal ?? []).map((row: any) => ({
      goal_id: row.goal_id,
      name: row.name ?? '(deleted goal)',
      ...shape(row),
    })),
  })
}).middleware('auth')

// ---------------------------------------------------------------------------
// Saved segments (#23)
// ---------------------------------------------------------------------------
// A segment is a named filter combination, stored as the same key/value bag the
// Stats API reads from the query string — so applying one is a merge, not a
// translation. Reading is a viewer right and writing is admin, matching funnels
// and goals: a segment holds no credential, and its results are numbers a viewer
// already reaches.
//
// Apply with `?segment=<id>` on any report endpoint. Request params win over the
// saved definition, because a segment is a starting point the reader narrows by
// clicking, and a save that overrode the last click would feel broken.

/** Validate a segment's filter bag, reusing the live grammar rather than a copy. */
function validateSegmentFilters(raw: unknown): { error: string } | { filters: Record<string, string> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'filters must be an object of filter params' }

  const bag = raw as Record<string, unknown>
  for (const [param, value] of Object.entries(bag)) {
    if (!parseFilterKey(param))
      return { error: `unknown filter: ${param}` }
    if (typeof value !== 'string' || value === '')
      return { error: `filter ${param} needs a non-empty string value` }
  }

  const specs = collectFilters(bag)
  if (!specs.length)
    return { error: 'a segment needs at least one filter' }

  const validated = validateFilters(specs)
  if ('error' in validated)
    return { error: validated.error }

  const filters: Record<string, string> = {}
  for (const [param, value] of Object.entries(bag))
    filters[param] = String(value)
  return { filters }
}

function segmentOut(row: any): Record<string, unknown> {
  return {
    id: row.id,
    site_id: row.site_id,
    name: row.name,
    filters: parseSegmentFilters(row.filters),
    created_at: row.created_at,
  }
}

route.options('/api/sites/{siteId}/segments', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/sites/{siteId}/segments', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const rows = await pgq(`SELECT * FROM segments WHERE site_id = ? ORDER BY created_at DESC`, [String(siteId)])
  return json({ segments: (rows ?? []).map(segmentOut) })
}).middleware('auth')

route.post('/api/sites/{siteId}/segments', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const body = request.jsonBody ?? {}
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : ''
  if (!name)
    return json({ error: 'name is required' }, 400)

  const validated = validateSegmentFilters(body.filters)
  if ('error' in validated)
    return json({ error: validated.error }, 400)

  const count = (await pgq(`SELECT COUNT(*) AS n FROM segments WHERE site_id = ?`, [String(siteId)]))?.[0]?.n
  if (Number(count ?? 0) >= 50)
    return json({ error: 'segment limit reached (50)' }, 409)

  const id = randomId()
  const now = new Date().toISOString()
  await pgq(
    `INSERT INTO segments (id, site_id, name, filters, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, String(siteId), name, JSON.stringify(validated.filters), now],
  )
  const row = (await pgq(`SELECT * FROM segments WHERE id = ?`, [id]))?.[0]
  return json({ segment: segmentOut(row) }, 201)
}).middleware('auth').skipCsrf()

route.options('/api/sites/{siteId}/segments/{segmentId}', () => new Response(null, { status: 204, headers: CORS }))

route.patch('/api/sites/{siteId}/segments/{segmentId}', async (request: any) => {
  const siteId = request.params.siteId
  const segmentId = request.params.segmentId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied

  const existing = (await pgq(`SELECT * FROM segments WHERE id = ? AND site_id = ? LIMIT 1`, [String(segmentId), String(siteId)]))?.[0]
  if (!existing)
    return json({ error: 'Segment not found' }, 404)

  const body = request.jsonBody ?? {}
  const updates: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : ''
    if (!name)
      return json({ error: 'name cannot be empty' }, 400)
    updates.name = name
  }

  if (body.filters !== undefined) {
    const validated = validateSegmentFilters(body.filters)
    if ('error' in validated)
      return json({ error: validated.error }, 400)
    updates.filters = JSON.stringify(validated.filters)
  }

  if (!Object.keys(updates).length)
    return json({ error: 'nothing to update' }, 400)

  updates.updated_at = new Date().toISOString()

  // Column names come from the fixed set above, never the request body.
  const columns = Object.keys(updates)
  await pgq(
    `UPDATE segments SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND site_id = ?`,
    [...columns.map(c => updates[c]), String(segmentId), String(siteId)],
  )
  const row = (await pgq(`SELECT * FROM segments WHERE id = ?`, [String(segmentId)]))?.[0]
  return json({ segment: segmentOut(row) })
}).middleware('auth').skipCsrf()

route.delete('/api/sites/{siteId}/segments/{segmentId}', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  await pgq(`DELETE FROM segments WHERE id = ? AND site_id = ?`, [String(request.params.segmentId), String(siteId)])
  return json({ ok: true })
}).middleware('auth').skipCsrf()

/** The filter grammar itself, so a client can build a segment UI without hardcoding it. */
route.options('/api/filters', () => new Response(null, { status: 204, headers: CORS }))

route.get('/api/filters', async () => {
  return json({
    dimensions: Object.keys(FILTER_COLUMNS),
    operators: FILTER_OPS,
    // Spelled out rather than left to a doc page that will drift from the code.
    syntax: '<dimension>[__<operator>]=<value>, e.g. path__matches=^/blog/',
    limits: { maxFilters: MAX_FILTERS, maxPatternLength: MAX_PATTERN_LENGTH },
  })
}).middleware('auth')

// ---------------------------------------------------------------------------
// Shareable read-only links (management API)
// ---------------------------------------------------------------------------
// The owner mints a per-site share token; anyone with `?share=<token>` gets a
// READ-ONLY dashboard for that site (the view layer hides all management). The
// token lives in the site's existing `settings` JSON (no schema change) and is
// revocable/rotatable. Management stays bearer-authed + owner-scoped, so a share
// viewer can never create/delete anything.

/** Read a site's settings JSON (tolerant of null/legacy non-JSON). */
async function readSiteSettings(siteId: string): Promise<Record<string, any>> {
  const rows = await pgq(`SELECT settings FROM sites WHERE id = ?`, [String(siteId)])
  try {
    return JSON.parse(rows?.[0]?.settings || '{}') || {}
  }
  catch {
    return {}
  }
}

route.options('/api/sites/{siteId}/share', () => new Response(null, { status: 204, headers: CORS }))

route.post('/api/sites/{siteId}/share', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  // Rotate on every POST: a fresh token invalidates any previously-shared link.
  const token = createHash('sha256').update(`${siteId}|${randomId()}|share`).digest('hex').slice(0, 32)
  const settings = await readSiteSettings(siteId)
  settings.share_token = token
  await pgq(`UPDATE sites SET settings = ? WHERE id = ?`, [JSON.stringify(settings), String(siteId)])
  return json({ token, path: `/dashboard?site=${encodeURIComponent(String(siteId))}&share=${token}` })
}).middleware('auth').skipCsrf()

route.delete('/api/sites/{siteId}/share', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'admin')
  if (denied)
    return denied
  const settings = await readSiteSettings(siteId)
  delete settings.share_token
  await pgq(`UPDATE sites SET settings = ? WHERE id = ?`, [JSON.stringify(settings), String(siteId)])
  return json({ ok: true })
}).middleware('auth').skipCsrf()

// ---------------------------------------------------------------------------
// Data deletion / erasure (management API)
// ---------------------------------------------------------------------------
// Operator + GDPR erasure. Owner-scoped. Visitor-level analytics live in these
// four tables (all keyed by site_id, and by the pseudonymous visitor_id).
const EVENT_TABLES = ['page_views', 'sessions', 'custom_events', 'conversions'] as const

/** Delete rows from every event table for a site, optionally scoped to one
 * visitor. Returns per-table deleted counts (via RETURNING). */
async function eraseRows(siteId: string, visitorId?: string): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {}
  for (const t of EVENT_TABLES) {
    const rows = visitorId
      ? await pgq(`DELETE FROM "${t}" WHERE site_id = ? AND visitor_id = ? RETURNING 1`, [String(siteId), String(visitorId)])
      : await pgq(`DELETE FROM "${t}" WHERE site_id = ? RETURNING 1`, [String(siteId)])
    deleted[t] = Array.isArray(rows) ? rows.length : 0
  }
  return deleted
}

route.options('/api/sites/{siteId}/data', () => new Response(null, { status: 204, headers: CORS }))

// Wipe all analytics data for a site (keeps the site and its goals config).
route.delete('/api/sites/{siteId}/data', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const deleted = await eraseRows(siteId)
  return json({ ok: true, deleted })
}).middleware('auth').skipCsrf()

route.options('/api/sites/{siteId}/visitors/{visitorId}', () => new Response(null, { status: 204, headers: CORS }))

// GDPR erasure for a single visitor id. The id is a 24h-rotating per-site hash,
// so this covers the rows sharing it (in practice one UTC day) — there is no
// durable key that could reach further back, by design.
route.delete('/api/sites/{siteId}/visitors/{visitorId}', async (request: any) => {
  const siteId = request.params.siteId
  const visitorId = request.params.visitorId
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const deleted = await eraseRows(siteId, visitorId)
  return json({
    ok: true,
    visitor_id: String(visitorId),
    deleted,
    note: 'visitor_id is a 24h-rotating hash; erasure reaches only rows sharing it (typically one UTC day).',
  })
}).middleware('auth').skipCsrf()

route.get('/api/sites/{siteId}/stats', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = await readFiltersWithSegment(request, siteId)
  if (flt.error)
    return json({ error: flt.error }, flt.error === 'Segment not found' ? 404 : 400)
  const withheld = await suppressedResponse(siteId, from, to, flt)
  if (withheld)
    return withheld
  const result = await filteredQuery(
    `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS sessions
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}`,
    [siteId, from, to, ...flt.params],
  )
  if ('response' in result)
    return result.response
  const row = result.rows[0]
  return json({
    views: Number(row?.views ?? 0),
    visitors: Number(row?.visitors ?? 0),
    sessions: Number(row?.sessions ?? 0),
    range: { from, to },
  })
}).middleware('auth')

route.get('/api/sites/{siteId}/timeseries', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = await readFiltersWithSegment(request, siteId)
  if (flt.error)
    return json({ error: flt.error }, flt.error === 'Segment not found' ? 404 : 400)
  const withheld = await suppressedResponse(siteId, from, to, flt)
  if (withheld)
    return withheld
  const result = await filteredQuery(
    `SELECT LEFT(timestamp, 10) AS day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}
    GROUP BY LEFT(timestamp, 10) ORDER BY day ASC`,
    [siteId, from, to, ...flt.params],
  )
  if ('response' in result)
    return result.response
  return json({ series: result.rows })
}).middleware('auth')

route.get('/api/sites/{siteId}/pages', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = await readFiltersWithSegment(request, siteId)
  if (flt.error)
    return json({ error: flt.error }, flt.error === 'Segment not found' ? 404 : 400)
  const withheld = await suppressedResponse(siteId, from, to, flt)
  if (withheld)
    return withheld
  const result = await filteredQuery(
    `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}
    GROUP BY path ORDER BY views DESC LIMIT 20`,
    [siteId, from, to, ...flt.params],
  )
  if ('response' in result)
    return result.response
  return json({ pages: result.rows })
}).middleware('auth')

route.get('/api/sites/{siteId}/referrers', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = await readFiltersWithSegment(request, siteId)
  if (flt.error)
    return json({ error: flt.error }, flt.error === 'Segment not found' ? 404 : 400)
  const withheld = await suppressedResponse(siteId, from, to, flt)
  if (withheld)
    return withheld
  const result = await filteredQuery(
    `SELECT referrer_source AS source, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}
    GROUP BY referrer_source ORDER BY views DESC LIMIT 20`,
    [siteId, from, to, ...flt.params],
  )
  if ('response' in result)
    return result.response
  return json({ referrers: result.rows })
}).middleware('auth')

// Owner-gated "top <dimension>" reports over page_views, so every dashboard
// breakdown has a documented JSON endpoint too (issue #15). `column` is always a
// fixed literal from the registrations below (never user input), so
// interpolating it into the query is safe.
function topDimension(path: string, column: string, key: string): void {
  route.get(path, async (request: any) => {
    const siteId = request.params.siteId
    const denied = await requireSiteRole(request, siteId, 'viewer')
    if (denied)
      return denied
    const { from, to } = window(request)
    const flt = await readFiltersWithSegment(request, siteId)
    if (flt.error)
      return json({ error: flt.error }, flt.error === 'Segment not found' ? 404 : 400)
    const withheld = await suppressedResponse(siteId, from, to, flt)
    if (withheld)
      return withheld
    const result = await filteredQuery(
      `SELECT ${column} AS name, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
      FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ? AND ${column} IS NOT NULL AND ${column} <> ''${flt.sql}
      GROUP BY ${column} ORDER BY views DESC LIMIT 20`,
      [siteId, from, to, ...flt.params],
    )
    if ('response' in result)
      return result.response
    return json({ [key]: result.rows })
  }).middleware('auth')
}

topDimension('/api/sites/{siteId}/countries', 'country', 'countries')
topDimension('/api/sites/{siteId}/devices', 'device_type', 'devices')
topDimension('/api/sites/{siteId}/browsers', 'browser', 'browsers')
topDimension('/api/sites/{siteId}/operating-systems', 'os', 'operating_systems')
topDimension('/api/sites/{siteId}/utm/sources', 'utm_source', 'sources')
topDimension('/api/sites/{siteId}/utm/mediums', 'utm_medium', 'mediums')
topDimension('/api/sites/{siteId}/utm/campaigns', 'utm_campaign', 'campaigns')

// Custom events, by name.
route.get('/api/sites/{siteId}/events', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)
  const rows = await pgq(
    `SELECT name, COUNT(*) AS events, COUNT(DISTINCT visitor_id) AS visitors
    FROM custom_events WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?
    GROUP BY name ORDER BY events DESC LIMIT 20`,
    [siteId, from, to],
  )
  return json({ events: rows ?? [] })
}).middleware('auth')

// Entry pages (session first page).
route.get('/api/sites/{siteId}/entry-pages', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)
  const rows = await pgq(
    `SELECT entry_path AS path, COUNT(*) AS sessions, COUNT(DISTINCT visitor_id) AS visitors
    FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at <= ?
    GROUP BY entry_path ORDER BY sessions DESC LIMIT 20`,
    [siteId, from, to],
  )
  return json({ entry_pages: rows ?? [] })
}).middleware('auth')

// Exit pages (session last page).
route.get('/api/sites/{siteId}/exit-pages', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const { from, to } = window(request)
  const rows = await pgq(
    `SELECT exit_path AS path, COUNT(*) AS sessions, COUNT(DISTINCT visitor_id) AS visitors
    FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at <= ?
    GROUP BY exit_path ORDER BY sessions DESC LIMIT 20`,
    [siteId, from, to],
  )
  return json({ exit_pages: rows ?? [] })
}).middleware('auth')

// Current visitors: unique visitors in the last ~5 minutes. Polled by the
// dashboard to keep the live count fresh without a reload (issue #20).
route.get('/api/sites/{siteId}/realtime', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteRole(request, siteId, 'viewer')
  if (denied)
    return denied
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const row = (await pgq(
    `SELECT COUNT(DISTINCT visitor_id) AS current FROM page_views WHERE site_id = ? AND timestamp >= ?`,
    [siteId, since],
  ))?.[0]
  return json({ current: Number(row?.current ?? 0) })
}).middleware('auth')

// ---------------------------------------------------------------------------
// Tracker script + health
// ---------------------------------------------------------------------------

// The tracker script is a STATIC asset (`public/script.js`), not a route: the
// views server only forwards `/api/*` and mutating methods to this backend, so
// a GET route here would be unreachable from the public origin. Serving it
// statically also lets it derive its own collect origin from `document
// .currentScript.src`, so one asset works on every host that fronts this app.

route.get('/api/health', () => response.json({ status: 'ok', app: 'analyticshq' }))
