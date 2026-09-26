/**
 * The public demo: a site that does not exist, with a year of traffic that
 * looks like one that does.
 *
 * Every "Live demo" and "See a live dashboard" link on the marketing site opens
 * DEMO_DASHBOARD_PATH, a read-only share link to this site. It used to open
 * /dashboard, which a signed-out visitor sees as a sign-in wall, and pointing it
 * at a real customer's site would publish their numbers.
 *
 * The rows are written by database/seeders/DemoSiteSeeder.ts. This file only
 * builds them, so the shape of the data can be tested without a database.
 *
 * DETERMINISTIC PER DAY
 *
 * Each day's traffic comes from a PRNG seeded with the site id and the date, so
 * building a day twice gives byte-identical rows. That is what lets the seeder
 * run every hour and only rebuild the last two days: history never shifts under
 * a reader who is comparing periods, and today fills in as the day goes on.
 *
 * WHAT REAL INGEST WOULD HAVE WRITTEN
 *
 * Referrer sources and device / browser / OS labels come from the same
 * parseReferrerSource and parseUserAgent the /collect route calls, fed real
 * referrer URLs and User-Agent strings. So the demo's "Hacker News" row and
 * "Safari / iOS" row are the strings a real beacon produces, not a guess at
 * them. Conversions use the /collect route's id scheme, one per session per
 * goal.
 */
import { createHash } from 'node:crypto'
import { DEMO_SITE_ID } from './demo-link'
import { cleanReferrer, parseUserAgent, referrerSource } from './tracking'

export { DEMO_DASHBOARD_PATH, DEMO_SHARE_TOKEN, DEMO_SITE_ID } from './demo-link'

export const DEMO_HOSTNAME = 'demo.analyticshq.org'

/** How much history the demo carries. A year, so the "1y" range is full. */
export const DEMO_DAYS = 365

/**
 * Bump when the generator changes shape. The seeder stores it on the site and
 * rebuilds every day when it differs, instead of only the last two.
 */
export const DEMO_VERSION = 1

export interface DemoGoal {
  id: string
  name: string
  type: 'pageview' | 'event'
  pattern: string
  match_type: 'exact' | 'starts_with'
  value?: number
  default_amount_minor?: number
  currency?: string
}

export const DEMO_GOALS: DemoGoal[] = [
  { id: 'demo-goal-signup', name: 'Signed up', type: 'pageview', pattern: '/welcome', match_type: 'exact' },
  { id: 'demo-goal-trial', name: 'Started a trial', type: 'event', pattern: 'Trial Started', match_type: 'exact' },
  { id: 'demo-goal-upgrade', name: 'Upgraded to Pro', type: 'event', pattern: 'Upgrade', match_type: 'exact', value: 19, default_amount_minor: 1900, currency: 'USD' },
  { id: 'demo-goal-docs', name: 'Read the docs', type: 'pageview', pattern: '/docs', match_type: 'starts_with' },
]

type Row = Record<string, string | number | boolean | null>

export interface DemoDay {
  sessions: Row[]
  pageViews: Row[]
  events: Row[]
  conversions: Row[]
  vitals: Row[]
  searchQueries: Row[]
}

// --- randomness -------------------------------------------------------------

type Rng = () => number

/** mulberry32: small, fast, and the same sequence on every runtime. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedOf(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0)
}

function pick<T>(rng: Rng, weighted: readonly (readonly [T, number])[]): T {
  let total = 0
  for (const [, w] of weighted)
    total += w
  let r = rng() * total
  for (const [value, w] of weighted) {
    r -= w
    if (r < 0)
      return value
  }
  return weighted[weighted.length - 1]![0]
}

function hex(rng: Rng, length: number): string {
  let out = ''
  while (out.length < length)
    out += Math.floor(rng() * 0x100000000).toString(16).padStart(8, '0')
  return out.slice(0, length)
}

/** Roughly normal, from the average of three uniforms. */
function around(rng: Rng, mean: number, spread: number): number {
  return mean + ((rng() + rng() + rng()) / 3 - 0.5) * 2 * spread
}

// --- the audience -----------------------------------------------------------

/** Country, weight, and UTC offset in hours (to place visits in local daytime). */
const COUNTRIES: readonly (readonly [[string, number], number])[] = [
  [['US', -6], 30], [['DE', 1], 9], [['GB', 0], 8], [['IN', 5.5], 7], [['CA', -5], 5],
  [['FR', 1], 5], [['NL', 1], 4], [['BR', -3], 3], [['JP', 9], 3], [['AU', 10], 3],
  [['ES', 1], 2], [['SE', 1], 2], [['PL', 1], 2], [['IT', 1], 2], [['CH', 1], 1.5],
  [['IE', 0], 1.5], [['KR', 9], 1], [['MX', -6], 1], [['ZA', 2], 1], [['SG', 8], 1],
  [['NO', 1], 1], [['DK', 1], 1], [['AT', 1], 1], [['FI', 2], 0.8], [['PT', 0], 0.8],
  [['AR', -3], 0.6], [['NZ', 12], 0.5], [['UA', 2], 0.5], [['TR', 3], 0.5], [['ID', 7], 0.5],
]

const USER_AGENTS: readonly (readonly [string, number])[] = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 24],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 18],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 9],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 14],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36', 9],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', 6],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 4],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 3],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0', 5],
  ['Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 3],
  ['Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 2],
]

// Parsed once: the labels are whatever real ingest would store for these strings.
const DEVICES = USER_AGENTS.map(([ua, w]) => [parseUserAgent(ua), w] as const)

interface Source {
  referrer?: string
  utm?: { source: string, medium: string, campaign: string, content?: string, term?: string }
  /** Share of sessions from this source that leave after one page. */
  bounce: number
  entries: readonly (readonly [string, number])[]
}

const BLOG = ['/blog/why-we-dropped-cookies', '/blog/postgres-for-analytics', '/blog/launch-week'] as const

const SOURCES: Record<string, Source> = {
  direct: { bounce: 0.4, entries: [['/', 60], ['/login', 15], ['/pricing', 10], ['/docs', 10], ['/changelog', 5]] },
  google: { referrer: 'https://www.google.com/', bounce: 0.5, entries: [['/', 30], ['/docs/getting-started', 14], ['/docs/self-hosting', 10], ['/docs/api', 6], [BLOG[0], 12], [BLOG[1], 13], ['/pricing', 15]] },
  bing: { referrer: 'https://www.bing.com/', bounce: 0.5, entries: [['/', 45], ['/docs', 20], ['/pricing', 20], [BLOG[1], 15]] },
  duckduckgo: { referrer: 'https://duckduckgo.com/', bounce: 0.46, entries: [['/', 40], [BLOG[0], 30], ['/docs/self-hosting', 30]] },
  hackernews: { referrer: 'https://news.ycombinator.com/item', bounce: 0.62, entries: [[BLOG[0], 70], ['/', 30]] },
  reddit: { referrer: 'https://www.reddit.com/r/webdev/', bounce: 0.58, entries: [[BLOG[0], 45], [BLOG[1], 40], ['/', 15]] },
  twitter: { referrer: 'https://t.co/', bounce: 0.6, entries: [[BLOG[2], 40], ['/', 35], ['/changelog', 25]] },
  linkedin: { referrer: 'https://www.linkedin.com/', bounce: 0.55, entries: [[BLOG[2], 50], ['/', 50]] },
  github: { referrer: 'https://github.com/stacksjs/analyticshq', bounce: 0.34, entries: [['/docs/self-hosting', 50], ['/docs', 30], ['/', 20]] },
  devto: { referrer: 'https://dev.to/', bounce: 0.52, entries: [[BLOG[1], 70], ['/', 30]] },
  newsletter: { bounce: 0.3, entries: [['/changelog', 55], [BLOG[2], 45]] },
  paid: { referrer: 'https://www.google.com/', bounce: 0.44, entries: [['/', 55], ['/pricing', 45]] },
  producthunt: { referrer: 'https://www.producthunt.com/posts/analyticshq', bounce: 0.5, entries: [['/', 85], ['/pricing', 15]] },
}

const BASE_MIX: readonly (readonly [string, number])[] = [
  ['direct', 30], ['google', 28], ['bing', 3], ['duckduckgo', 3], ['hackernews', 2], ['reddit', 4],
  ['twitter', 5], ['linkedin', 3], ['github', 7], ['devto', 2], ['newsletter', 0], ['paid', 4],
]

/**
 * Launches and mentions: a day on which one source sends a burst of extra
 * visitors, decaying over the days after. `ago` counts back from today, so the
 * demo always shows a recent spike to explain.
 */
const SPIKES: readonly { ago: number, source: string, extra: number }[] = [
  { ago: 41, source: 'hackernews', extra: 950 },
  { ago: 143, source: 'producthunt', extra: 700 },
  { ago: 262, source: 'reddit', extra: 380 },
]

/** Next page, by current page. Anything unlisted goes home or leaves. */
const NEXT: Record<string, readonly (readonly [string, number])[]> = {
  '/': [['/pricing', 25], ['/features', 20], ['/docs', 15], ['/blog', 10], ['/signup', 12], ['/customers', 8], ['/about', 5], ['/login', 5]],
  '/features': [['/pricing', 35], ['/signup', 20], ['/docs', 20], ['/', 10], ['/customers', 15]],
  '/pricing': [['/signup', 45], ['/features', 15], ['/docs', 15], ['/', 10], ['/customers', 15]],
  '/docs': [['/docs/getting-started', 50], ['/docs/api', 30], ['/docs/self-hosting', 20]],
  '/docs/getting-started': [['/docs/api', 35], ['/docs/self-hosting', 25], ['/signup', 25], ['/pricing', 15]],
  '/docs/api': [['/docs/getting-started', 40], ['/docs/self-hosting', 30], ['/pricing', 30]],
  '/docs/self-hosting': [['/docs/getting-started', 50], ['/pricing', 30], ['/signup', 20]],
  '/blog': [[BLOG[0], 30], [BLOG[1], 30], [BLOG[2], 25], ['/', 15]],
  [BLOG[0]]: [['/', 35], ['/pricing', 20], [BLOG[1], 25], ['/signup', 20]],
  [BLOG[1]]: [['/', 30], ['/docs/self-hosting', 30], [BLOG[0], 20], ['/signup', 20]],
  [BLOG[2]]: [['/', 35], ['/changelog', 25], ['/pricing', 20], ['/signup', 20]],
  '/changelog': [['/', 40], ['/docs', 30], ['/pricing', 30]],
  '/customers': [['/pricing', 50], ['/signup', 30], ['/', 20]],
  '/about': [['/', 50], ['/customers', 30], ['/pricing', 20]],
  '/signup': [['/welcome', 55], ['/pricing', 20], ['/', 25]],
  '/welcome': [['/docs/getting-started', 70], ['/', 30]],
  '/login': [['/', 100]],
}

/** Share of visits in each LOCAL hour: quiet overnight, busiest mid-afternoon. */
const HOURS = [1, 0.6, 0.4, 0.3, 0.3, 0.5, 1, 2, 3.5, 5, 6, 6.5, 6, 6.5, 7, 7, 6.5, 5.5, 4.5, 4, 3.5, 3, 2.5, 1.5]
const HOUR_WEIGHTS = HOURS.map((w, h) => [h, w] as const)

/** Sunday first, as Date.getUTCDay counts. */
const WEEKDAY = [0.62, 1, 1.06, 1.04, 1, 0.9, 0.66]

const SEARCHES: readonly (readonly [string, string, number, number])[] = [
  // query, page, daily impressions at today's traffic, average position
  ['privacy friendly analytics', '/', 320, 6.2],
  ['google analytics alternative', '/', 540, 11.4],
  ['cookieless analytics', BLOG[0], 260, 4.1],
  ['web analytics without cookies', BLOG[0], 180, 5.3],
  ['self hosted analytics postgres', '/docs/self-hosting', 120, 2.8],
  ['postgres analytics', BLOG[1], 150, 7.9],
  ['plausible alternative', '/', 210, 9.6],
  ['gdpr compliant analytics', '/', 190, 8.4],
  ['analyticshq', '/', 90, 1.1],
  ['open source web analytics', '/', 230, 12.7],
  ['core web vitals monitoring', '/docs', 70, 14.2],
  ['analytics api', '/docs/api', 60, 10.5],
]

// --- one day ----------------------------------------------------------------

const DAY_MS = 864e5

/** Midnight UTC, `ago` days before `now`. */
export function demoDayStart(now: Date, ago: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ago))
}

/**
 * Visitors on a day, before spikes: growing from about 90 a day a year ago to
 * about 260 now, lower at weekends and over the new year.
 */
function baseVisitors(day: Date, ago: number, rng: Rng): number {
  const growth = 90 + 170 * ((1 - ago / DEMO_DAYS) ** 1.4)
  const md = (day.getUTCMonth() + 1) * 100 + day.getUTCDate()
  const holidays = md >= 1222 || md <= 102 ? 0.68 : 1
  return Math.round(growth * WEEKDAY[day.getUTCDay()]! * holidays * around(rng, 1, 0.12))
}

/**
 * Every row for one UTC day, `ago` days before `now`. Rows timestamped after
 * `now` are dropped, so today holds what has "happened" so far.
 */
export function buildDemoDay(now: Date, ago: number): DemoDay {
  const day = demoDayStart(now, ago)
  const date = day.toISOString().slice(0, 10)
  const rng = mulberry32(seedOf(`${DEMO_SITE_ID}|${date}|v${DEMO_VERSION}`))
  // Nothing crosses midnight: the seeder rebuilds whole days by deleting from a
  // day's start, so a session that spilled into the next day would leave its
  // tail behind to be orphaned by that delete.
  const cutoff = Math.min(now.getTime(), day.getTime() + DAY_MS - 1)
  const out: DemoDay = { sessions: [], pageViews: [], events: [], conversions: [], vitals: [], searchQueries: [] }

  // Newsletter every other Tuesday, which is what makes the email campaign rows.
  const newsletter = day.getUTCDay() === 2 && Math.floor(day.getTime() / (7 * DAY_MS)) % 2 === 0
  const month = date.slice(0, 7)

  const plan: string[] = []
  const visitors = baseVisitors(day, ago, rng)
  for (let i = 0; i < visitors; i++)
    plan.push(pick(rng, BASE_MIX))
  if (newsletter) {
    for (let i = 0; i < Math.round(visitors * 0.18); i++)
      plan.push('newsletter')
  }
  for (const spike of SPIKES) {
    const since = spike.ago - ago
    if (since >= 0 && since < 4) {
      const extra = Math.round(spike.extra * [1, 0.38, 0.14, 0.06][since]! * around(rng, 1, 0.1))
      for (let i = 0; i < extra; i++)
        plan.push(spike.source)
    }
  }

  for (const sourceKey of plan) {
    const source = SOURCES[sourceKey]!
    const [country, offset] = pick(rng, COUNTRIES)
    const ua = pick(rng, DEVICES)
    const visitorId = hex(rng, 32)
    const visits = rng() < 0.12 ? 2 : 1

    let lastStart = 0
    for (let v = 0; v < visits; v++) {
      // Local hour to UTC, then a random minute. A second visit lands later the
      // same day, or not at all.
      const localHour = pick(rng, HOUR_WEIGHTS)
      let start = day.getTime() + (((localHour - offset + 24) % 24) * 3600 + rng() * 3600) * 1000
      if (v > 0) {
        start = lastStart + (1 + rng() * 5) * 3600 * 1000
        if (start > cutoff)
          break
      }
      lastStart = start
      if (start > cutoff)
        continue

      const sessionId = hex(rng, 32)
      const utm = sourceKey === 'newsletter'
        ? { source: 'newsletter', medium: 'email', campaign: `changelog-${month}`, content: rng() < 0.7 ? 'header-link' : 'footer-link' }
        : sourceKey === 'paid'
          ? { source: 'google', medium: 'cpc', campaign: 'brand-search', term: pick(rng, [['privacy analytics', 5], ['cookieless analytics', 3], ['analyticshq', 2]] as const) }
          : sourceKey === 'producthunt'
            ? { source: 'producthunt', medium: 'launch', campaign: 'launch-day' }
            : undefined
      const rawReferrer = source.referrer
      const referrer = cleanReferrer(rawReferrer)
      const refSource = referrerSource(rawReferrer)

      // The path through the site.
      const paths: string[] = [pick(rng, source.entries)]
      if (rng() >= source.bounce) {
        while (paths.length < 9) {
          const next = NEXT[paths[paths.length - 1]!]
          if (!next)
            break
          paths.push(pick(rng, next))
          if (rng() > 0.56)
            break
        }
      }

      let t = start
      const times = paths.map((_, i) => {
        if (i > 0)
          t += Math.max(4, around(rng, 55, 50) * (rng() < 0.15 ? 3 : 1)) * 1000
        return t
      })

      let eventCount = 0
      const matched = new Set<string>()
      const convert = (goal: DemoGoal, at: number, path: string): void => {
        if (matched.has(goal.id) || at > cutoff)
          return
        matched.add(goal.id)
        out.conversions.push({
          id: createHash('sha256').update(`${sessionId}|${goal.id}`).digest('hex').slice(0, 32),
          site_id: DEMO_SITE_ID,
          goal_id: goal.id,
          visitor_id: visitorId,
          session_id: sessionId,
          value: goal.value ?? null,
          amount_minor: goal.default_amount_minor ?? null,
          currency: goal.default_amount_minor == null ? null : goal.currency ?? null,
          path,
          referrer_source: refSource,
          utm_source: utm?.source ?? null,
          utm_campaign: utm?.campaign ?? null,
          timestamp: new Date(at).toISOString(),
        })
      }
      const event = (name: string, path: string, at: number, properties: Record<string, unknown> | null): void => {
        if (at > cutoff)
          return
        eventCount++
        out.events.push({
          id: hex(rng, 24),
          site_id: DEMO_SITE_ID,
          session_id: sessionId,
          visitor_id: visitorId,
          name,
          properties: properties ? JSON.stringify(properties) : null,
          path,
          timestamp: new Date(at).toISOString(),
        })
        for (const goal of DEMO_GOALS) {
          if (goal.type === 'event' && goal.pattern === name)
            convert(goal, at, path)
        }
      }

      let kept = 0
      paths.forEach((path, i) => {
        const at = times[i]!
        if (at > cutoff)
          return
        kept++
        const stamp = new Date(at).toISOString()
        out.pageViews.push({
          id: hex(rng, 24),
          site_id: DEMO_SITE_ID,
          session_id: sessionId,
          visitor_id: visitorId,
          path,
          hostname: DEMO_HOSTNAME,
          referrer: i === 0 ? referrer : null,
          referrer_source: refSource,
          utm_source: utm?.source ?? null,
          utm_medium: utm?.medium ?? null,
          utm_campaign: utm?.campaign ?? null,
          utm_content: utm?.content ?? null,
          utm_term: utm?.term ?? null,
          country,
          device_type: ua.deviceType,
          browser: ua.browser,
          os: ua.os,
          // /collect writes both false; nothing reads them.
          is_unique: false,
          is_bounce: false,
          time_on_page: i < paths.length - 1 ? Math.round((times[i + 1]! - at) / 1000) : 0,
          timestamp: stamp,
        })

        for (const goal of DEMO_GOALS) {
          if (goal.type === 'pageview' && (goal.match_type === 'exact' ? path === goal.pattern : path.startsWith(goal.pattern)))
            convert(goal, at, path)
        }

        // What people do on the page.
        const later = at + (5 + rng() * 25) * 1000
        if (path === '/welcome') {
          event('Sign Up', path, later, null)
          if (rng() < 0.38) {
            event('Trial Started', path, later + 20000, { plan: 'pro' })
            if (rng() < 0.16)
              event('Upgrade', path, later + 60000, { plan: 'pro', value: 19, currency: 'USD' })
          }
        }
        if (path.startsWith('/docs') && rng() < 0.22)
          event('Copy Snippet', path, later, { snippet: path === '/docs/api' ? 'api-request' : 'script-tag' })
        if (path === '/docs/self-hosting' && rng() < 0.18)
          event('File Download', path, later, { url: `https://${DEMO_HOSTNAME}/downloads/${rng() < 0.6 ? 'docker-compose.yml' : 'analyticshq-cli-2.4.0.pkg'}` })
        if ((path.startsWith('/docs') || path.startsWith('/blog/')) && rng() < 0.09) {
          event('Outbound Link', path, later, { url: pick(rng, [
            ['https://github.com/stacksjs/analyticshq', 50],
            ['https://www.postgresql.org/docs/', 20],
            ['https://web.dev/articles/vitals', 15],
            ['https://news.ycombinator.com/', 15],
          ] as const) })
        }

        // Core Web Vitals from a sample of views, like the tracker's own
        // sampling. Phones are slower, and the home page carries the hero.
        if (rng() < 0.08) {
          const phone = ua.deviceType === 'mobile'
          const heavy = path === '/' || path.startsWith('/blog/')
          const lcp = Math.max(500, around(rng, (phone ? 2500 : 1500) * (heavy ? 1.3 : 1), 900))
          const metrics: [string, number][] = [
            ['LCP', lcp],
            ['FCP', Math.max(300, lcp * around(rng, 0.55, 0.15))],
            ['TTFB', Math.max(40, around(rng, phone ? 380 : 220, 150))],
            ['INP', Math.max(16, around(rng, phone ? 190 : 90, 80))],
            ['CLS', Math.max(0, Number(around(rng, heavy ? 0.08 : 0.03, 0.05).toFixed(3)))],
          ]
          for (const [metric, value] of metrics) {
            if (at + 3000 > cutoff)
              break
            out.vitals.push({
              id: hex(rng, 24),
              site_id: DEMO_SITE_ID,
              visitor_id: visitorId,
              path,
              metric,
              value: metric === 'CLS' ? value : Math.round(value),
              timestamp: new Date(at + 3000).toISOString(),
              device_type: ua.deviceType,
            })
          }
        }
      })

      if (!kept)
        continue
      const last = Math.min(times[kept - 1]!, cutoff)
      out.sessions.push({
        id: sessionId,
        site_id: DEMO_SITE_ID,
        visitor_id: visitorId,
        entry_path: paths[0]!,
        exit_path: paths[kept - 1]!,
        referrer,
        referrer_source: refSource,
        utm_source: utm?.source ?? null,
        utm_medium: utm?.medium ?? null,
        utm_campaign: utm?.campaign ?? null,
        country,
        device_type: ua.deviceType,
        browser: ua.browser,
        os: ua.os,
        page_view_count: kept,
        event_count: eventCount,
        is_bounce: kept === 1,
        duration: Math.round((last - start) / 1000),
        started_at: new Date(start).toISOString(),
        ended_at: new Date(last).toISOString(),
      })
    }
  }

  // Search Console reports whole days, a couple of days late.
  if (ago >= 2) {
    const scale = baseVisitors(day, ago, mulberry32(seedOf(`${date}|search`))) / 260
    for (const [query, path, impressions, position] of SEARCHES) {
      const shown = Math.max(0, Math.round(impressions * scale * around(rng, 1, 0.25)))
      if (!shown)
        continue
      const pos = Math.max(1, around(rng, position, position * 0.15))
      const ctr = Math.min(0.45, 0.32 / pos ** 1.1)
      out.searchQueries.push({
        id: createHash('sha256').update(`${DEMO_SITE_ID}|${date}|${query}|${path}`).digest('hex').slice(0, 32),
        site_id: DEMO_SITE_ID,
        date,
        query,
        path,
        clicks: Math.round(shown * ctr * around(rng, 1, 0.2)),
        impressions: shown,
        position: Number(pos.toFixed(1)),
      })
    }
  }

  return out
}
