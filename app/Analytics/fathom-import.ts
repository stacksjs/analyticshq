/**
 * Fathom Analytics import - reading a dashboard CSV export into a site.
 *
 * The synthesis, the row shapes and the insert are NOT here: they live in
 * `ga-import.ts` and are shared, because two spellings of "what an imported row
 * becomes" would be free to disagree, and a disagreement shows up as a
 * customer's numbers changing depending on which importer they used. This file
 * is only the part that is genuinely Fathom's: reading its export and deciding
 * what a record means when the export cannot say.
 *
 * ## What Fathom's export actually contains
 *
 * A folder of ~18 CSVs, each a finished breakdown - `Pages.csv` is path to
 * visitors/pageviews/bounce/time, `Browsers.csv` is browser to visitors, and so
 * on. Two consequences drive everything below.
 *
 * **There are no timestamps.** The only time information in the whole export is
 * one cell in `Summary.csv`: a single range like "2026-09-02 00:00:00 to
 * 2026-09-08 16:02:04 (UTC)". Not per-day rows - one range for the lot. So
 * traffic is spread evenly across the days in that range. A real arrival
 * distribution is not recoverable and inventing a plausible-looking one would
 * be a claim we cannot support; an obviously flat line is honest about being
 * synthetic.
 *
 * **The dimensions are not cross-tabulated.** The export says 3 Chrome visitors
 * and 3 Desktop visitors; it does not say how many were both. The joint
 * distribution is absent from the data, not merely inconvenient to compute, so
 * no importer can recover it. What `allocate()` below does is assign each
 * dimension independently in proportion to its own totals, which reproduces
 * every MARGINAL total exactly - browser counts, country counts, device counts
 * all match Fathom - while making no claim about how they combine. A "Chrome on
 * Windows in Texas" row here means "one visitor, and separately Chrome, Windows
 * and Texas each got one" - it does not mean Fathom saw that person.
 *
 * That limit is worth stating in the UI if imported history is ever segmented
 * by two dimensions at once, because that is the one question this data cannot
 * answer and the dashboard will answer it anyway.
 *
 * Rows carry `fap_`/`fas_` id prefixes, the Fathom counterparts of GA's
 * `gap_`/`gas_`, so `--replace` removes a prior Fathom import without touching
 * real traffic or a GA import.
 */
import type { GaRecord } from './ga-import'
import { normCountry } from './country'
import { clip, normDevice, normOs, splitCsv, toInt } from './ga-import'

export const FATHOM_PAGE_VIEW_PREFIX = 'fap_'
export const FATHOM_SESSION_PREFIX = 'fas_'

/** One dimension's breakdown: label -> visitor count. */
export type Breakdown = Map<string, number>

export interface FathomExport {
  /** YYYY-MM-DD, inclusive. */
  from: string
  to: string
  /** path -> { visitors, pageviews } */
  pages: Map<string, { visitors: number, pageviews: number }>
  countries: Breakdown
  devices: Breakdown
  browsers: Breakdown
  systems: Breakdown
  sources: Breakdown
}

/**
 * Fathom's device vocabulary is not ours: it says Phone where page_views stores
 * mobile. Left unmapped, an import would introduce a fourth device type that
 * every existing dashboard query ignores, and the imported traffic would appear
 * to have no devices at all.
 */
const DEVICE_MAP: Record<string, string> = {
  phone: 'mobile',
  mobile: 'mobile',
  desktop: 'desktop',
  tablet: 'tablet',
}

/**
 * Fathom writes "Direct / Unknown" for traffic with no referrer, where this app
 * writes "Direct". Mapped rather than passed through so imported direct traffic
 * groups with native direct traffic instead of sitting beside it as a
 * near-duplicate label.
 */
export function normFathomSource(v: string): string {
  const s = (v || '').trim()
  if (!s || /^direct\b/i.test(s) || /unknown/i.test(s))
    return 'Direct'
  return s
}

export function normFathomDevice(v: string): string {
  return DEVICE_MAP[(v || '').trim().toLowerCase()] || normDevice(v)
}

/** Parse a two-column "label,count" CSV into a breakdown, skipping the header. */
export function parseBreakdown(csv: string, labelCol = 0, countCol = -1): Breakdown {
  const out: Breakdown = new Map()
  const lines = csv.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2)
    return out
  const header = splitCsv(lines[0])
  const idx = countCol >= 0 ? countCol : header.length - 1
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line)
    const label = (cells[labelCol] || '').trim()
    if (!label)
      continue
    out.set(label, (out.get(label) || 0) + toInt(cells[idx]))
  }
  return out
}

/**
 * The export's date range, from the one cell that carries it.
 *
 * Returns whole days inclusive. Fathom writes the end as the moment of export
 * ("to 2026-09-08 16:02:04"), so the final day is partial - it is still counted
 * as a day, because dropping it would move traffic that genuinely happened on
 * it onto the day before.
 */
export function parseRange(summaryCsv: string): { from: string, to: string } | null {
  const m = summaryCsv.match(/(\d{4}-\d{2}-\d{2})[^\n]*?to\s+(\d{4}-\d{2}-\d{2})/)
  if (!m)
    return null
  return { from: m[1], to: m[2] }
}

/** Every YYYY-MM-DD from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  const end = new Date(`${to}T00:00:00Z`).getTime()
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86400_000)
    out.push(new Date(t).toISOString().slice(0, 10))
  return out.length ? out : [from]
}

/**
 * Deal `total` units out across a breakdown, in proportion, deterministically.
 *
 * Largest-remainder rather than rounding each share independently: independent
 * rounding loses or gains units and the imported totals then disagree with
 * Fathom's by a few, which is exactly the kind of small unexplained drift that
 * makes people distrust an import. This always sums to `total`.
 *
 * Ordered by descending share so the allocation is stable across runs - a
 * re-import must produce the same ids, and the ids are derived from these
 * assignments.
 */
export function allocate(breakdown: Breakdown, total: number): string[] {
  const entries = [...breakdown.entries()].filter(([, n]) => n > 0)
  if (!entries.length || total <= 0)
    return Array.from({ length: Math.max(total, 0) }, () => 'Unknown')

  const sum = entries.reduce((s, [, n]) => s + n, 0)
  const exact = entries.map(([label, n]) => ({ label, want: (n / sum) * total }))
  const out: string[] = []
  const floored = exact.map(e => ({ ...e, take: Math.floor(e.want) }))
  for (const e of floored) {
    for (let i = 0; i < e.take; i++) out.push(e.label)
  }
  // Hand the shortfall to the largest remainders, biggest first.
  let short = total - out.length
  const byRemainder = [...floored].sort((a, b) => (b.want - b.take) - (a.want - a.take) || b.want - a.want)
  for (let i = 0; short > 0; i++, short--) out.push(byRemainder[i % byRemainder.length].label)
  return out
}

/**
 * Which day the i-th of `count` visitors lands on, across `days` days.
 *
 * Spans both endpoints rather than filling from the front: `i % days` packs
 * everyone into the first N days and leaves the tail of the range empty, which
 * reads as "traffic stopped" rather than "there were fewer visitors than days".
 * With 5 visitors over 7 days this gives days 0,1,3,4,6 - first and last both
 * used, gaps in between, which is the honest shape for data this sparse.
 */
export function spreadIndex(i: number, count: number, days: number): number {
  if (days <= 1 || count <= 1)
    return 0
  return Math.min(days - 1, Math.round((i * (days - 1)) / (count - 1)))
}

/**
 * Turn a parsed export into the records the shared synthesis understands.
 *
 * One record per (day, path, source, country, device, browser, os) combination
 * that the allocation produced. Visitors are dealt across days first so a
 * multi-week export does not land as a single spike, then each dimension is
 * dealt independently across those visitors - see the joint-distribution note
 * at the top of this file for what that does and does not mean.
 */
export function toRecords(exp: FathomExport): GaRecord[] {
  const days = daysBetween(exp.from, exp.to)
  const records = new Map<string, GaRecord>()

  for (const [path, { visitors, pageviews }] of exp.pages) {
    if (visitors <= 0)
      continue
    const countries = allocate(exp.countries, visitors)
    const devices = allocate(exp.devices, visitors)
    const browsers = allocate(exp.browsers, visitors)
    const systems = allocate(exp.systems, visitors)
    const sources = allocate(exp.sources, visitors)
    // Pageviews follow visitors, so a path with more views per visitor keeps that ratio.
    const viewsPer = allocate(new Map([['v', visitors]]), pageviews).length

    for (let i = 0; i < visitors; i++) {
      // Spread across the range, not filled from the front. `i % days.length`
      // packs visitors into the first N days and leaves the tail of the range
      // empty, which reads as "traffic stopped" rather than "there were fewer
      // visitors than days". This lands them evenly end to end.
      const date = days[spreadIndex(i, visitors, days.length)]
      const source = normFathomSource(sources[i])
      const country = normCountry(countries[i])
      const device = normFathomDevice(devices[i])
      const browser = clip(browsers[i] || 'Unknown', 32)
      const os = clip(normOs(systems[i] || 'Unknown'), 32)
      const k = `${date}|${path}|${source}|${country}|${device}|${browser}|${os}`
      const rec = records.get(k) ?? {
        date,
        path: clip(path, 255),
        source,
        medium: null,
        campaign: null,
        country,
        device,
        browser,
        os,
        pageviews: 0,
        sessions: 0,
        users: 0,
      }
      rec.users += 1
      rec.sessions += 1
      rec.pageviews += Math.max(1, Math.round(viewsPer / Math.max(visitors, 1)))
      records.set(k, rec)
    }
  }
  return [...records.values()]
}
