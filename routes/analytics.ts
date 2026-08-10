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

import { createHash } from 'node:crypto'
import { db } from '@stacksjs/database'
import { response, route } from '@stacksjs/router'
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

// Dimensions the Stats API can filter by, mapped to their page_views column.
// The dashboard's click-to-filter exposes the same set. Keys are the query
// params; columns are fixed literals (never user input), so interpolating them
// is safe — the values are always parameterized.
const FILTER_COLUMNS: Record<string, string> = {
  path: 'path',
  source: 'referrer_source',
  referrer: 'referrer',
  country: 'country',
  device: 'device_type',
  browser: 'browser',
  os: 'os',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  utm_term: 'utm_term',
}

/**
 * Build ` AND <col> = ?` fragments + params from any filter query params present.
 * Composes with AND, matching the dashboard's filter engine, so /pages?country=US
 * &device=Mobile narrows a page_views report to that segment.
 */
function readFilters(req: { query: Record<string, any> }): { sql: string, params: unknown[] } {
  let sql = ''
  const params: unknown[] = []
  for (const [key, col] of Object.entries(FILTER_COLUMNS)) {
    const v = req.query?.[key]
    if (typeof v === 'string' && v !== '') {
      sql += ` AND ${col} = ?`
      params.push(v)
    }
  }
  return { sql, params }
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
  if (request.headers?.get('sec-gpc') === '1')
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
  const SESSION_WINDOW_MS = 30 * 60 * 1000
  const sessionSince = new Date(Date.now() - SESSION_WINDOW_MS).toISOString()
  const recentSession = (await pgq(
    `SELECT session_id FROM page_views WHERE site_id = ? AND visitor_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1`,
    [String(siteId), visitorId, sessionSince],
  ).catch(() => [])) as Array<{ session_id: string }>
  const sessionId = recentSession[0]?.session_id
    ? String(recentSession[0].session_id)
    : createHash('sha256').update(`${siteId}|${visitorId}|${Math.floor(Date.now() / SESSION_WINDOW_MS)}`).digest('hex').slice(0, 32)
  const info = parseUserAgent(ua)
  const country = geoCountry(request.headers)
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
      title: clip255(body.t),
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
      screen_width: body.sw ?? null,
      screen_height: body.sh ?? null,
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
      `SELECT id, type, pattern, match_type, value FROM goals WHERE site_id = ? AND is_active = true LIMIT 100`,
      [String(siteId)],
    )
    for (const goal of (goals ?? []) as GoalRow[]) {
      if (!matchesGoal(goal, { isPageview, path, eventName }))
        continue
      // Deterministic id + ON CONFLICT DO NOTHING => once per session per goal. Stores the
      // goal's value and this beacon's attribution + timestamp.
      await db.insertOrIgnore('conversions', {
        id: conversionId(sessionId, goal.id),
        site_id: String(siteId),
        goal_id: goal.id,
        visitor_id: visitorId,
        session_id: sessionId,
        value: goal.value ?? null,
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
async function requireSiteOwner(request: any, siteId: string): Promise<Response | null> {
  const uid = authUserId(request)
  if (!uid)
    return json({ error: 'Unauthorized' }, 401)
  const rows = await pgq(`SELECT owner_id FROM sites WHERE id = ? LIMIT 1`, [String(siteId)])
  const site = rows?.[0]
  if (!site)
    return json({ error: 'Site not found' }, 404)
  if (site.owner_id == null || String(site.owner_id) !== uid)
    return json({ error: 'Forbidden' }, 403)
  return null
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
  const rows = await pgq(
    `SELECT id, name, domains, timezone, is_active, created_at
    FROM sites WHERE owner_id = ? ORDER BY created_at DESC`,
    [Number(uid)],
  )
  return json({ sites: rows ?? [] })
}).middleware('auth')

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
  const denied = await requireSiteOwner(request, siteId)
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
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const rows = await pgq(
    `SELECT id, site_id, name, type, pattern, match_type, value, is_active
    FROM goals WHERE site_id = ? ORDER BY created_at DESC`,
    [siteId],
  )
  return json({ goals: rows ?? [] })
}).middleware('auth')

route.post('/api/sites/{siteId}/goals', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteOwner(request, siteId)
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
    is_active: true,
  }).execute()

  return json({ goal: { id, site_id: String(siteId), name, type, pattern, match_type: matchType, value, is_active: true } }, 201)
})
  // Management endpoint: authenticated (bearer token — CSRF-immune) AND scoped to
  // the site's owner via requireSiteOwner() in the handler.
  .middleware('auth')
  .skipCsrf()

route.options('/api/sites/{siteId}/goals/{goalId}', () => new Response(null, { status: 204, headers: CORS }))

route.delete('/api/sites/{siteId}/goals/{goalId}', async (request: any) => {
  const siteId = request.params.siteId
  const goalId = request.params.goalId
  const denied = await requireSiteOwner(request, siteId)
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
  const denied = await requireSiteOwner(request, siteId)
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
  const denied = await requireSiteOwner(request, siteId)
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
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = readFilters(request)
  const row = (await pgq(
    `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS sessions
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}`,
    [siteId, from, to, ...flt.params],
  ))?.[0]
  return json({
    views: Number(row?.views ?? 0),
    visitors: Number(row?.visitors ?? 0),
    sessions: Number(row?.sessions ?? 0),
    range: { from, to },
  })
}).middleware('auth')

route.get('/api/sites/{siteId}/timeseries', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = readFilters(request)
  const rows = await pgq(
    `SELECT LEFT(timestamp, 10) AS day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}
    GROUP BY LEFT(timestamp, 10) ORDER BY day ASC`,
    [siteId, from, to, ...flt.params],
  )
  return json({ series: rows ?? [] })
}).middleware('auth')

route.get('/api/sites/{siteId}/pages', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = readFilters(request)
  const rows = await pgq(
    `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}
    GROUP BY path ORDER BY views DESC LIMIT 20`,
    [siteId, from, to, ...flt.params],
  )
  return json({ pages: rows ?? [] })
}).middleware('auth')

route.get('/api/sites/{siteId}/referrers', async (request: any) => {
  const siteId = request.params.siteId
  const denied = await requireSiteOwner(request, siteId)
  if (denied)
    return denied
  const { from, to } = window(request)
  const flt = readFilters(request)
  const rows = await pgq(
    `SELECT referrer_source AS source, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
    FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ?${flt.sql}
    GROUP BY referrer_source ORDER BY views DESC LIMIT 20`,
    [siteId, from, to, ...flt.params],
  )
  return json({ referrers: rows ?? [] })
}).middleware('auth')

// Owner-gated "top <dimension>" reports over page_views, so every dashboard
// breakdown has a documented JSON endpoint too (issue #15). `column` is always a
// fixed literal from the registrations below (never user input), so
// interpolating it into the query is safe.
function topDimension(path: string, column: string, key: string): void {
  route.get(path, async (request: any) => {
    const siteId = request.params.siteId
    const denied = await requireSiteOwner(request, siteId)
    if (denied)
      return denied
    const { from, to } = window(request)
    const flt = readFilters(request)
    const rows = await pgq(
      `SELECT ${column} AS name, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
      FROM page_views WHERE site_id = ? AND timestamp >= ? AND timestamp <= ? AND ${column} IS NOT NULL AND ${column} <> ''${flt.sql}
      GROUP BY ${column} ORDER BY views DESC LIMIT 20`,
      [siteId, from, to, ...flt.params],
    )
    return json({ [key]: rows ?? [] })
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
  const denied = await requireSiteOwner(request, siteId)
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
  const denied = await requireSiteOwner(request, siteId)
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
  const denied = await requireSiteOwner(request, siteId)
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
  const denied = await requireSiteOwner(request, siteId)
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
