/**
 * Core Web Vitals (#41) — pure helpers.
 *
 * Nothing here touches the database or a Request, so every rule below is
 * directly testable: the thresholds, the percentile, what counts as a legal
 * measurement, and when a percentile is refused rather than reported.
 *
 * ## Which metrics, and the one we deliberately dropped
 *
 * LCP, CLS, INP, FCP, TTFB. NOT FID — Google retired First Input Delay in
 * favour of INP in March 2024, and INP supersedes it (it measures every
 * interaction, not only the first). ts-analytics still collects FID; porting it
 * would have meant shipping a metric that was already withdrawn, and our own
 * marketing only ever claimed LCP/INP/CLS.
 *
 * ## Milliseconds, except CLS
 *
 * CLS is a unitless ratio, typically 0.05–0.25. Every other metric is a
 * duration in milliseconds. This is the only per-metric special case in the
 * file and it lives in exactly one place — the threshold table — because the
 * previous implementation's habit of scaling CLS on the wire and unscaling it
 * at read time is what produced ts-analytics#133.
 */

/** The five metrics we collect, in the order the dashboard shows them. */
export const VITAL_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const

export type VitalMetric = (typeof VITAL_METRICS)[number]
export type VitalRating = 'good' | 'needs-improvement' | 'poor'

/**
 * Google's published good/needs-improvement boundaries. A value at or below the
 * first is good; at or below the second is needs-improvement; above is poor.
 *
 * These are the same numbers PageSpeed Insights and Search Console use, which
 * matters more than it looks: a site owner who sees "poor" here and "good"
 * there would rightly stop trusting both.
 */
export const VITAL_THRESHOLDS: Record<VitalMetric, [good: number, poor: number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
}

/**
 * Largest value we will accept, per metric.
 *
 * A beacon is attacker-controlled, so this is a validation bound rather than a
 * display convenience. Rejecting is deliberate — clamping a bogus 10^9 down to
 * the cap would turn junk into a plausible-looking measurement and drag the
 * percentile with it, which is exactly the outcome the bound exists to prevent.
 *
 * One hour for timings is far past any real page load and still finite. CLS has
 * no theoretical ceiling, but a layout shifting 10x its own viewport is already
 * beyond "poor" by two orders of magnitude.
 */
const VITAL_MAX: Record<VitalMetric, number> = {
  LCP: 3_600_000,
  INP: 3_600_000,
  CLS: 10,
  FCP: 3_600_000,
  TTFB: 3_600_000,
}

export function isVitalMetric(value: unknown): value is VitalMetric {
  return typeof value === 'string' && (VITAL_METRICS as readonly string[]).includes(value)
}

/** Where a single measurement falls against the published thresholds. */
export function rating(metric: VitalMetric, value: number): VitalRating {
  const [good, poor] = VITAL_THRESHOLDS[metric]
  if (value <= good)
    return 'good'
  if (value <= poor)
    return 'needs-improvement'
  return 'poor'
}

/**
 * Nearest-rank percentile: the smallest value at or below which at least `p` of
 * the samples fall.
 *
 * Nearest-rank rather than linear interpolation because an interpolated p75 is a
 * number no visitor actually experienced, and the whole claim of field data is
 * that these are real measurements. It is also what CrUX reports, so our number
 * and Google's answer the same question.
 *
 * `values` is sorted here rather than by the caller — a caller that forgot would
 * get a wrong answer rather than an error, and the cost is irrelevant beside the
 * query that produced the rows.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0)
    return null
  const sorted = [...values].sort((a, b) => a - b)
  // ceil(p × n) is 1-based; clamp covers p = 0 and floating-point landing at n+1.
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)))
  return sorted[rank - 1]
}

export interface VitalSample {
  metric: VitalMetric
  value: number
}

/**
 * Validate the `p` bag of a vitals beacon into the samples worth storing.
 *
 * Unknown keys, unparseable numbers, negatives and out-of-range values are
 * dropped INDIVIDUALLY rather than failing the whole beacon: a browser that
 * reports a nonsense INP should not also cost us its perfectly good LCP.
 *
 * Duplicates keep the first occurrence. JSON objects cannot legally repeat a
 * key, so reaching that line means a hand-built payload, and taking the first is
 * both deterministic and not worth a branch anyone has to think about.
 */
export function parseVitalsPayload(payload: unknown): VitalSample[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return []
  const out: VitalSample[] = []
  const seen = new Set<string>()
  for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (!isVitalMetric(key) || seen.has(key))
      continue
    // Numbers only. A numeric STRING is rejected rather than coerced: our own
    // tracker sends numbers, so a string means something else is talking to us
    // and guessing at its intent is how junk gets into a percentile.
    if (typeof raw !== 'number' || !Number.isFinite(raw))
      continue
    if (raw < 0 || raw > VITAL_MAX[key])
      continue
    seen.add(key)
    out.push({ metric: key, value: raw })
  }
  return out
}

/**
 * Render a measurement the way the metric is conventionally read.
 *
 * CLS is a ratio and is written to three decimals (0.083); everything else is a
 * duration, shown in ms under a second and seconds above it — 1.8s rather than
 * 1800ms, because that is how every vitals tool and every Google doc writes it.
 *
 * Formatting lives beside the thresholds on purpose. A panel that formatted CLS
 * as "0ms" would be the same class of mistake as storing it in an integer, and
 * keeping both facts in one file is what makes that hard to do by accident.
 */
export function formatVital(metric: VitalMetric, value: number): string {
  if (metric === 'CLS')
    return value.toFixed(3)
  if (value < 1000)
    return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(2)}s`
}

/** Google's own colours for the three bands, so the panel reads like the tools it matches. */
export const RATING_COLOR: Record<VitalRating, string> = {
  'good': '#10b981',
  'needs-improvement': '#f59e0b',
  'poor': '#ef4444',
}

export interface VitalReport {
  metric: VitalMetric
  /** The p75, or null when there were too few samples to report one. */
  value: number | null
  /** Rating of `value`, or null when `value` is. */
  rating: VitalRating | null
  /** How many measurements the percentile drew on. Always reported. */
  samples: number
  /** True when samples fell under the minimum and the percentile was withheld. */
  suppressed: boolean
}

/**
 * One metric's percentile as Postgres computed it, before any policy is applied.
 *
 * `percentile_disc(0.75)` is the SQL spelling of `percentile(values, 0.75)`
 * above — both are nearest-rank, both return a value some visitor actually
 * measured. The percentile is computed in SQL rather than here because the row
 * count is unbounded (one per metric per page view), and a report that has to
 * pull a month of raw measurements into memory to sort them stops working on
 * exactly the sites that most need it.
 *
 * That leaves the definition in two languages, which the segments migration
 * warns about at length. It is checked rather than trusted: a test feeds the
 * same rows through Postgres and through `percentile()` and asserts they agree,
 * so the day they diverge is the day that test goes red.
 */
export interface VitalAggregate {
  metric: string
  p75: number | null
  samples: number
}

/**
 * Apply rating and the disclosure floor to the aggregates SQL produced.
 *
 * This is the half that is NOT duplicated in SQL — thresholds and suppression
 * live here and only here, so the query stays a plain group-and-percentile.
 *
 * ## Why a percentile is suppressed where a total is not
 *
 * #40 established that unfiltered totals are NEVER suppressed — "you had 3
 * visitors yesterday" identifies nobody. A percentile is a different kind of
 * number and the rule does not carry over unchanged. A count over few people
 * reveals nothing about any of them; a p75 over one person is not a statistic at
 * all, it is that person's phone and network, reported to the site owner as a
 * device characteristic. So the floor applies here even without a filter.
 *
 * It is also arithmetic hygiene: the 75th percentile of two samples is the
 * larger one. Publishing that as "your p75" would be wrong before it was
 * private, and an owner acting on it would be chasing one visitor's phone.
 *
 * `minimum <= 0` disables the check, exactly as it does for segments, so a
 * single-user install can still see its own numbers.
 */
export function buildReport(aggregates: VitalAggregate[], minimum: number): VitalReport[] {
  const found = new Map<VitalMetric, VitalAggregate>()
  for (const row of aggregates) {
    if (isVitalMetric(row.metric))
      found.set(row.metric, row)
  }

  // Every metric appears in the output, including ones with no samples at all —
  // a dashboard that silently omits INP is indistinguishable from one where INP
  // is broken, and "no data yet" is the more useful of the two answers.
  return VITAL_METRICS.map((metric) => {
    const row = found.get(metric)
    const samples = Number(row?.samples ?? 0)
    const raw = row?.p75
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    const suppressed = minimum > 0 && samples > 0 && samples < minimum
    const shown = suppressed ? null : value
    return {
      metric,
      value: shown,
      rating: shown === null ? null : rating(metric, shown),
      samples,
      suppressed,
    }
  })
}
