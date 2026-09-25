/**
 * Axis maths for the Traffic chart on the dashboard.
 *
 * Lives in a real .ts module, like the formatters in dashboard-format.ts, because
 * tsc cannot see inside a .stx file and these are pure functions worth testing.
 *
 * The chart used to draw two labels, the first and last bucket, and no y scale
 * at all, so a reader could see a shape but not read a value off it without
 * hovering each column. This adds the two things a chart needs to be read at a
 * glance: gridlines at round numbers, and dates spread along the bottom.
 */

/**
 * The smallest "round" number at or above `max`: 1, 2, 2.5 or 5 times a power of
 * ten. The y scale tops out here rather than at the raw peak, so the gridlines
 * land on values a person would write down (0 / 50 / 100, not 0 / 43 / 86).
 */
export function niceCeil(max: number): number {
  if (!Number.isFinite(max) || max <= 0)
    return 1
  const exp = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * exp >= max)
      return step * exp
  }
  return 10 * exp
}

/** Gridline values for a nice maximum: 0, half, and the top. */
export function yTicks(niceMax: number): Array<{ value: number, label: string }> {
  return [niceMax, niceMax / 2, 0].map(value => ({ value, label: compactCount(value) }))
}

/** 1234 -> "1.2k", 1500000 -> "1.5M"; small numbers as they are. */
export function compactCount(n: number): string {
  if (n >= 1_000_000)
    return `${trimZero((n / 1_000_000).toFixed(1))}M`
  if (n >= 10_000)
    return `${Math.round(n / 1000)}k`
  if (n >= 1000)
    return `${trimZero((n / 1000).toFixed(1))}k`
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A bucket key as an axis label. Keys are what the chart query groups by:
 * `YYYY-MM-DDTHH` hourly, `YYYY-MM-DD` daily, `YYYY-MM` monthly. Dates are read
 * as written, never through Date(), so a label cannot drift by a timezone.
 */
export function axisLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:T(\d{2}))?/.exec(key)
  if (!m)
    return key
  const [, year, month, day, hour] = m
  const mon = MONTHS[Number(month) - 1] ?? month
  if (hour !== undefined)
    return `${hour}:00`
  if (day !== undefined)
    return `${mon} ${Number(day)}`
  return `${mon} ${year}`
}

/**
 * Up to `count` evenly spaced bucket indices for x-axis labels, always including
 * the first and last, each with its horizontal position as a percentage of the
 * plot width (the centre of that bucket's column, which is where its point sits).
 */
export function xTicks(keys: readonly string[], count = 5): Array<{ label: string, leftPct: number }> {
  const n = keys.length
  if (!n)
    return []
  const want = Math.max(1, Math.min(count, n))
  const idx = want === 1
    ? [0]
    : Array.from({ length: want }, (_, i) => Math.round((i * (n - 1)) / (want - 1)))
  return [...new Set(idx)].map(i => ({ label: axisLabel(keys[i]), leftPct: ((i + 0.5) / n) * 100 }))
}
