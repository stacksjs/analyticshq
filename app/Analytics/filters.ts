/**
 * The filter grammar behind the Stats API and saved segments (#23).
 *
 * Before this, a filter was equality only: `?country=US` became `AND country = ?`.
 * That covers click-to-filter, which is where it came from, and nothing else —
 * there was no way to ask for "every blog post" or "everything except /admin".
 *
 * ## The syntax, and why it is a suffix
 *
 *   ?path=/pricing              equals          (unchanged)
 *   ?path__not=/admin           not equals
 *   ?path__contains=blog        substring
 *   ?path__matches=^/blog/\d+   regular expression
 *   ?path__not_matches=^/admin  negated regular expression
 *
 * The operator rides in the parameter NAME rather than the value. The tempting
 * alternative — a value prefix like `?path=~^/blog/` — makes a literal value
 * starting with `~` unrepresentable and needs an escaping rule that someone will
 * eventually get wrong. A name suffix cannot collide with any value at all.
 *
 * Bare `?path=` stays equality, so every existing dashboard link keeps working.
 *
 * ## On regular expressions and denial of service
 *
 * A user-supplied regex the server runs is normally a ReDoS vector, and the usual
 * defence is to reject nested quantifiers. That defence is NOT here, deliberately,
 * because it was measured rather than assumed: Postgres does not use a
 * backtracking engine like JavaScript's, and every classic catastrophic pattern —
 * `(a+)+$`, `(a*)*$`, `(a|a)*$`, `(a|aa)+$` — matched a 41-character subject in
 * under a millisecond. The worst case found was a bounded state explosion,
 * `^(a{1,100}){1,100}$`, at 110ms, and Postgres rejects oversized repetition
 * counts itself with "invalid repetition count(s)".
 *
 * Rejecting nested quantifiers would therefore have blocked legitimate patterns
 * to defend against a vulnerability this database does not have. What is enforced
 * instead is a length cap, which bounds how large a state machine a pattern can
 * ask for, and every filtered query is already narrowed by an indexed
 * `site_id`+`timestamp` range before a regex sees a row.
 *
 * The residual risk is row multiplication — a cheap regex over a very large
 * range — which is a general query-cost problem rather than a regex one. The
 * backstop for that is a database-level `statement_timeout`, which was verified
 * to take effect on this pool. It is set in deployment rather than per query here,
 * because manipulating connection state around individual queries leaks settings
 * between concurrent requests on a shared pool.
 */

export type FilterOp = 'eq' | 'not' | 'contains' | 'matches' | 'not_matches'

export const FILTER_OPS: readonly FilterOp[] = ['eq', 'not', 'contains', 'matches', 'not_matches'] as const

/**
 * Dimensions the Stats API can filter by, mapped to their page_views column.
 * Columns are fixed literals and never come from a caller, which is what makes
 * interpolating them safe; every VALUE is parameterised.
 */
export const FILTER_COLUMNS: Record<string, string> = {
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

/** Bounds how large a state machine one pattern can ask Postgres to build. */
export const MAX_PATTERN_LENGTH = 200

/** How many filters one request or segment may combine. */
export const MAX_FILTERS = 12

export interface FilterSpec {
  /** The query-param key, e.g. `path`. */
  key: string
  op: FilterOp
  value: string
}

export function isFilterOp(v: unknown): v is FilterOp {
  return typeof v === 'string' && (FILTER_OPS as readonly string[]).includes(v)
}

/**
 * Split a parameter name into its dimension and operator.
 *
 * Returns null for anything not a known dimension, so unrelated query params
 * (`startDate`, `segment`, `page`) pass through untouched rather than being
 * mistaken for filters.
 */
export function parseFilterKey(param: string): { key: string, op: FilterOp } | null {
  const separator = param.indexOf('__')
  if (separator === -1)
    return param in FILTER_COLUMNS ? { key: param, op: 'eq' } : null

  const key = param.slice(0, separator)
  const op = param.slice(separator + 2)
  if (!(key in FILTER_COLUMNS) || !isFilterOp(op))
    return null
  return { key, op }
}

/**
 * Collect filters from a flat key/value bag — query params or a saved segment,
 * which deliberately share a shape so a segment is applied by merging rather than
 * translated by a second code path that could disagree.
 */
export function collectFilters(source: Record<string, unknown>): FilterSpec[] {
  const specs: FilterSpec[] = []
  for (const [param, raw] of Object.entries(source ?? {})) {
    const parsed = parseFilterKey(param)
    if (!parsed)
      continue
    if (typeof raw !== 'string' || raw === '')
      continue
    specs.push({ key: parsed.key, op: parsed.op, value: raw })
  }
  return specs
}

/**
 * Validate a set of filters.
 *
 * Returns the first problem rather than a list: these are typed into a URL or a
 * form one at a time, and a wall of messages for a single mistake is noise.
 */
export function validateFilters(specs: FilterSpec[]): { error: string } | { ok: true } {
  if (specs.length > MAX_FILTERS)
    return { error: `a maximum of ${MAX_FILTERS} filters can be combined` }

  for (const spec of specs) {
    if (!(spec.key in FILTER_COLUMNS))
      return { error: `unknown filter dimension: ${spec.key}` }
    if (!isFilterOp(spec.op))
      return { error: `unknown filter operator: ${spec.op}` }
    if (spec.value.length > 255)
      return { error: `filter values are limited to 255 characters` }
    if ((spec.op === 'matches' || spec.op === 'not_matches') && spec.value.length > MAX_PATTERN_LENGTH)
      return { error: `patterns are limited to ${MAX_PATTERN_LENGTH} characters` }
  }

  return { ok: true }
}

/**
 * Turn filters into a SQL fragment and its parameters.
 *
 * Negations are written to include NULL rows. `country <> 'US'` is NULL — and
 * therefore false — for a row whose country is unknown, so the obvious spelling
 * of "not the US" silently drops every visitor we could not geolocate. That is a
 * wrong answer that looks like a smaller one, which is the worst kind.
 *
 * `contains` uses POSITION rather than LIKE on purpose. With LIKE, a `%` inside
 * the parameterised value is still a wildcard, so `?path__contains=100%25` would
 * quietly match far more than it says. POSITION has no wildcard semantics to
 * escape and therefore no escaping rule to get wrong.
 */
export function buildFilterSql(specs: FilterSpec[]): { sql: string, params: unknown[] } {
  let sql = ''
  const params: unknown[] = []

  for (const spec of specs) {
    const column = FILTER_COLUMNS[spec.key]
    if (!column)
      continue

    switch (spec.op) {
      case 'eq':
        sql += ` AND ${column} = ?`
        params.push(spec.value)
        break
      case 'not':
        // IS DISTINCT FROM rather than <>, so unknown values count as "not it".
        sql += ` AND ${column} IS DISTINCT FROM ?`
        params.push(spec.value)
        break
      case 'contains':
        sql += ` AND POSITION(? IN COALESCE(${column}, '')) > 0`
        params.push(spec.value)
        break
      case 'matches':
        sql += ` AND ${column} ~ ?`
        params.push(spec.value)
        break
      case 'not_matches':
        // Same NULL reasoning as `not`: a row with no value does not match the
        // pattern, so it belongs in the negation.
        sql += ` AND (${column} IS NULL OR ${column} !~ ?)`
        params.push(spec.value)
        break
    }
  }

  return { sql, params }
}

/** The stored shape of a segment's filters: the same bag as query params. */
export function parseSegmentFilters(raw: string | null): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v !== '' && parseFilterKey(k))
        out[k] = v
    }
    return out
  }
  catch {
    return {}
  }
}

/**
 * Merge a saved segment with the request's own filters.
 *
 * Request parameters win. A segment is a starting point the reader then narrows
 * by clicking, and having the saved definition silently override what they just
 * clicked would make the dashboard feel broken.
 */
export function mergeFilters(segment: Record<string, string>, request: Record<string, unknown>): Record<string, unknown> {
  return { ...segment, ...request }
}
