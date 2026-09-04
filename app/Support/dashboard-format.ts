/**
 * Pure formatting and classification helpers for the dashboard.
 *
 * These lived as untyped functions inside dashboard.stx's <script server> block. They
 * are here rather than annotated in place for one reason: tsc cannot see inside a .stx
 * file, so an annotation written there is erased by the transpiler and verified by
 * nothing. app/Support/**\/*.ts is on the tsconfig include path, so these signatures are
 * actually checked.
 *
 * Only genuinely pure helpers moved. Anything that closes over request-scoped state --
 * kpis, siteId, range, activeFilters, granularity -- stays in the page, because dragging
 * that state through a parameter list would be worse than leaving it where it is read.
 */

/** The four buckets every referrer folds into. */
export type ChannelName = 'Direct' | 'Search' | 'Social' | 'Referral'

/** A SQL fragment plus its bound parameters, appended to a WHERE clause. */
export interface ChannelPredicate {
  sql: string
  params: string[]
}

/**
 * Referrer sources that count as Search / Social. Exported because channelOf (display)
 * and channelPredicate (filtering) MUST agree -- if they drift, a visitor clicking the
 * "Search" slice gets a row count that does not match the slice they clicked.
 */
export const CH_SEARCH: ReadonlySet<string> = new Set([
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'baidu',
  'ecosia',
])

export const CH_SOCIAL: ReadonlySet<string> = new Set([
  'twitter',
  'x',
  'facebook',
  'instagram',
  'linkedin',
  'reddit',
  'hacker news',
  'youtube',
  'mastodon',
  'bluesky',
  'tiktok',
])

/** Fold an app-classified referrer_source string into one of the four channels. */
export function channelOf(src: string | null | undefined): ChannelName {
  const s = String(src ?? '').trim().toLowerCase()
  if (!s || s === 'direct')
    return 'Direct'
  if (CH_SEARCH.has(s))
    return 'Search'
  if (CH_SOCIAL.has(s))
    return 'Social'
  return 'Referral'
}

/**
 * The filtering half of channelOf. TRIMs the column so the match is identical to
 * channelOf's String(src).trim() bucketing -- a ' Direct' referrer must filter the same
 * way the channel panel folds it.
 */
export function channelPredicate(name: ChannelName): ChannelPredicate {
  if (name === 'Search' || name === 'Social') {
    const arr = [...(name === 'Search' ? CH_SEARCH : CH_SOCIAL)]
    return { sql: ` AND TRIM(referrer_source) IN (${arr.map(() => '?').join(',')})`, params: arr }
  }
  if (name === 'Direct')
    return { sql: ` AND (TRIM(referrer_source) IN ('', 'Direct') OR referrer_source IS NULL)`, params: [] }
  // Referral: has a referrer that is neither Direct nor in the Search/Social sets.
  const other = [...CH_SEARCH, ...CH_SOCIAL]
  return {
    sql: ` AND referrer_source IS NOT NULL AND TRIM(referrer_source) NOT IN ('', 'Direct'${other.length ? `, ${other.map(() => '?').join(', ')}` : ''})`,
    params: other,
  }
}

/** Regional-indicator flag emoji for a 2-letter country code; '' when not resolvable. */
export function flag(code: string | null | undefined): string {
  if (!code || String(code).length !== 2)
    return ''
  return String.fromCodePoint(...[...String(code).toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
}

/**
 * ISO 3166-1 alpha-2 -> English country name: 'US' -> 'United States'.
 *
 * Intl.DisplayNames rather than a table shipped with the app: it is ICU-backed,
 * covers every assigned code, and Bun and the browser return the same string for
 * the same input. That last part is what lets the map's tooltips and the Top
 * countries list agree without either shipping names to the other -- and the two
 * disagreeing about what a country is called is exactly the confusion the map
 * script's own comments already guard against.
 *
 * Two failure modes, both falling back to the raw code. A malformed subtag
 * ('T1', which older writers could still have left in the table) makes `of`
 * throw a RangeError, and an unthrown dashboard is worth more than a pretty
 * label. A well-formed but unassigned code ('XX') is returned unchanged, which
 * is already the fallback, so it needs no special case.
 *
 * The formatter is built once: constructing one costs a locale-data lookup, and
 * the map asks for 177 of these on every render.
 */
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' })

export function countryName(code: string | null | undefined): string {
  if (!code || String(code).length !== 2)
    return String(code ?? '')
  try {
    return REGION_NAMES.of(String(code).toUpperCase()) ?? String(code)
  }
  catch {
    return String(code)
  }
}

/** Signed percent change against the previous period; null when there is no baseline. */
export function pct(cur: number, prev: number): number | null {
  if (!prev)
    return null
  return Math.round(((cur - prev) / prev) * 100)
}

/** Human-readable visit duration from a seconds count: "0s", "45s", "1m 23s". */
export function fmtDuration(secs: number | string | null | undefined): string {
  const s = Math.max(0, Math.round(Number(secs) || 0))
  if (s < 60)
    return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Outbound Link / File Download events store {"url":"..."} in properties, so
 * GROUP BY properties == GROUP BY url. Unwrap it for display, falling back to the raw
 * string when it is not the expected shape.
 */
export function eventUrl(props: string | null | undefined): string {
  try {
    const o = JSON.parse(String(props)) as { url?: unknown } | null
    return o && o.url ? String(o.url) : String(props)
  }
  catch {
    return String(props)
  }
}
