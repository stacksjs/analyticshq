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

/**
 * CSV text one upload may carry, measured before JSON escaping.
 *
 * 5 MB rather than 10: the files travel as JSON string values, and escaping
 * inflates them, so a 10 MB selection would arrive as roughly 12 MB of body and
 * cross the 10,485,760-byte ceiling bun-router's request-size middleware
 * imposes if it is ever registered on this app. Half of it leaves room for the
 * escaping and for the ceiling to arrive later without breaking anyone.
 */
export const FATHOM_MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/**
 * Page views one request will write.
 *
 * Checked BEFORE synthesis, never during: a Fathom export covers one fixed
 * range, so a half-written import cannot be finished by re-exporting a shorter
 * one. A shorter export has different breakdown totals, so `allocate` and
 * `reconcileVisitors` land on a different split and mint different ids, and the
 * second attempt would stack on top of the first rather than collide with it.
 * Over the cap the whole request is refused and the caller splits the range
 * instead, which is deterministic and does collide.
 */
export const FATHOM_MAX_ROWS_PER_REQUEST = 50_000

/** The files this importer reads. Everything else in a Fathom export is ignored. */
export const FATHOM_FILES = [
  'Summary.csv',
  'Pages.csv',
  'Countries.csv',
  'Device_Types.csv',
  'Browsers.csv',
  'Operating_Systems.csv',
  'Sources.csv',
] as const

/**
 * Present in a Fathom export and deliberately not read, so the UI can name them
 * rather than leaving the customer to notice their other files vanished.
 *
 * These are not-yet: each has a column waiting for it. The sub-country geo
 * files a Fathom export also carries are a different case and are absent from
 * this list on purpose - migration 0000000011 dropped those two columns from
 * both tables because country-only geolocation is an invariant here (#7), so
 * there is nothing for them to be imported INTO. The panel says so in prose;
 * the module does not name the files, because naming them is how a later
 * "completeness" pass talks itself into reading them.
 */
export const FATHOM_IGNORED_FILES = [
  'Referrers.csv',
  'Entry_Pages.csv',
  'Exit_Pages.csv',
  'Events.csv',
  'UTM_Campaign.csv',
  'UTM_Content.csv',
  'UTM_Medium.csv',
  'UTM_Source.csv',
  'UTM_Term.csv',
] as const

/** One dimension's breakdown: label -> visitor count. */
export type Breakdown = Map<string, number>

export interface FathomExport {
  /** YYYY-MM-DD, inclusive. */
  from: string
  to: string
  /**
   * Site-wide totals from `Summary.csv`: deduplicated people, and pageviews.
   *
   * `people` is the number every other breakdown is denominated in, and it is
   * NOT the sum of `pages` visitors - see `toRecords`. Zero means the summary
   * did not carry it, which is the one case reconciliation is skipped.
   */
  people: number
  pageviews: number
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
  // By header name first, by position only as a fallback.
  //
  // The last column is the visitor count in all five files read today, and was
  // the whole rule. It is also a loaded gun for the next file added: the last
  // column of `Referrers.csv` is its bounce rate, so reading it positionally
  // returns 100 as a visitor count, and the last column of the entry and exit
  // page files is pageviews rather than visitors. Both would import numbers
  // that look entirely plausible.
  const named = header.findIndex(h => /^visitors$/i.test(h.trim().replace(/^"|"$/g, '')))
  const idx = countCol >= 0 ? countCol : (named >= 0 ? named : header.length - 1)
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
  // Anchored on the label first. The loose scan below takes the first date pair
  // joined by "to" ANYWHERE in the file, which is correct only for as long as
  // that row holds the only dates in it - and Fathom has added rows to this
  // file before, without a schema version to notice it by. A "Generated on"
  // line above it would silently move the whole import into the wrong window.
  const labelled = summaryCsv.match(/"?Export Date Range"?[^\n]*?(\d{4}-\d{2}-\d{2})[^\n]*?to\s+(\d{4}-\d{2}-\d{2})/)
  const m = labelled ?? summaryCsv.match(/(\d{4}-\d{2}-\d{2})[^\n]*?to\s+(\d{4}-\d{2}-\d{2})/)
  if (!m)
    return null
  return { from: m[1], to: m[2] }
}

/**
 * The site-wide totals `Summary.csv` reports, by row label.
 *
 * `People` is the one number in the whole export that is deduplicated across
 * pages, which makes it the denominator every other breakdown is written in:
 * Countries, Browsers, Device_Types, Operating_Systems and Sources each sum to
 * it, while `Pages.csv` visitors do NOT - a person who read three pages is
 * counted on all three. Reading it is what lets `toRecords` keep the marginals
 * honest.
 *
 * Missing rows come back as 0 rather than throwing: Fathom has added rows to
 * this file before (Entry/Exit pages arrived in the March 2026 rebuild) and an
 * export that renames one should degrade to the old behaviour, not refuse to
 * import.
 */
export function parseSummaryTotals(summaryCsv: string): { people: number, pageviews: number } {
  const rows = new Map<string, string>()
  for (const line of summaryCsv.split(/\r?\n/)) {
    const cells = splitCsv(line)
    if (cells.length >= 2 && cells[0].trim())
      rows.set(cells[0].trim().toLowerCase(), cells[1])
  }
  return {
    people: toInt(rows.get('people') ?? ''),
    pageviews: toInt(rows.get('pageviews') ?? ''),
  }
}

/**
 * How many dashboard filters were on when the export was taken.
 *
 * Fathom's export respects whatever filters the dashboard had applied, so a
 * filtered export is a SUBSET of the site that looks exactly like a complete
 * one. Imported unchecked it reads as a quiet period that never happened. A
 * missing or unreadable row counts as zero, which is the reading that lets an
 * older export through rather than refusing everything it cannot classify.
 */
export function parseFiltersApplied(summaryCsv: string): number {
  for (const line of summaryCsv.split(/\r?\n/)) {
    const cells = splitCsv(line)
    if (cells.length >= 2 && cells[0].trim().toLowerCase() === 'filters applied')
      return toInt(cells[1])
  }
  return 0
}

/**
 * The name a file was given, without whatever path it arrived under.
 *
 * A folder picker hands over `Dashboard_Export_2026-09-08/Pages.csv` and a
 * zip listing can be worse. Only the basename is ever matched, so nothing
 * about the path a customer's browser reports can steer which file is read.
 */
export function fathomBasename(name: string): string {
  const parts = String(name).split(/[/\\]/).filter(p => p !== '')
  return parts.length ? parts[parts.length - 1] : ''
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
 * Split `total` into `slots` whole parts that sum to exactly `total`.
 *
 * The counterpart to `allocate` for the case where the shares are equal and
 * only the count matters. It exists because the obvious spelling - give every
 * slot `Math.round(total / slots)` - is wrong in both directions and was: three
 * visitors over four pageviews each rounded to 1 and the import reproduced 3 of
 * Fathom's 4, while two visitors over five rounded to 3 each and reproduced 6 of
 * 5. Neither is visible on a small export, and both are exactly the unexplained
 * drift `allocate` was written to avoid.
 *
 * The remainder goes to the front slots, deterministically, so a re-import
 * produces the same split and therefore the same row ids.
 */
export function dealEvenly(total: number, slots: number): number[] {
  if (slots <= 0)
    return []
  const base = Math.floor(Math.max(total, 0) / slots)
  const rest = Math.max(total, 0) - base * slots
  return Array.from({ length: slots }, (_, i) => base + (i < rest ? 1 : 0))
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
 * How many visitors each page should contribute, denominated in real people.
 *
 * `Pages.csv` counts visitors PER PAGE, so someone who read three pages appears
 * on three rows and the column sums to more than `Summary.csv`'s `People`. Every
 * other breakdown in the export - countries, devices, browsers, systems, sources
 * - sums to `People` instead. Dealing each of those across the page column, which
 * is what this used to do, therefore stretched all five of them by the same
 * factor: a site whose pages summed to 3x its people imported three times its
 * real country, device and browser counts, and a headline visitor number three
 * times what Fathom shows. On the single-page export this was written against,
 * the two columns are equal and none of it is visible.
 *
 * Scaling the page column back down to `People` is the only move that restores
 * every marginal at once. What it cannot restore is which pages the overlap was
 * on, because the export does not say - so this is proportional, and a page's
 * own visitor count is the thing that gives.
 *
 * A page Fathom shows never scales to nothing: the floor is one visitor, so a
 * long tail survives as a long tail. On a site with more pages than people that
 * floor wins and the total comes back above `People`, which the caller reports
 * rather than hides.
 */
export function reconcileVisitors(
  pages: Map<string, { visitors: number, pageviews: number }>,
  people: number,
): { counts: Map<string, number>, rawTotal: number, total: number } {
  const entries = [...pages.entries()].filter(([, p]) => p.visitors > 0)
  const rawTotal = entries.reduce((n, [, p]) => n + p.visitors, 0)
  const counts = new Map<string, number>()

  // Nothing to reconcile when the summary is silent, or when the pages already
  // agree with it, or when they somehow sum to less - inventing visitors to
  // reach `People` would be manufacturing traffic rather than redistributing it.
  if (people <= 0 || !entries.length || rawTotal <= people) {
    for (const [path, p] of entries)
      counts.set(path, p.visitors)
    return { counts, rawTotal, total: rawTotal }
  }

  const shares = entries.map(([path, p]) => ({ path, want: (p.visitors / rawTotal) * people }))
  const taken = shares.map(s => ({ ...s, take: Math.max(1, Math.floor(s.want)) }))
  // Largest remainders first, exactly as `allocate` does, so the two agree on
  // what a fair split is and a re-import lands on the same numbers.
  const byRemainder = [...taken].sort((a, b) => (b.want - b.take) - (a.want - a.take) || b.want - a.want)
  let short = people - taken.reduce((n, t) => n + t.take, 0)
  for (let i = 0; short > 0; i++, short--)
    byRemainder[i % byRemainder.length].take++

  for (const t of taken)
    counts.set(t.path, t.take)
  return { counts, rawTotal, total: taken.reduce((n, t) => n + t.take, 0) }
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
  const { counts } = reconcileVisitors(exp.pages, exp.people)

  // ONE visitor list for the whole import, not one per page.
  //
  // Allocating a dimension inside the page loop rounds it once per page, and
  // largest-remainder always hands the leftover to the biggest share - so the
  // error does not cancel, it accumulates toward the most common browser and
  // country. Three pages was enough to turn 90 US / 30 Canada into 91 / 29.
  // Allocating once across every visitor makes each marginal exact by
  // construction, whatever the page count.
  //
  // The ordering key spreads each page's visitors evenly through that single
  // list rather than giving it a contiguous block. A contiguous block would
  // hand the first page every US visitor and the last page every Canadian one,
  // because `allocate` returns its labels grouped - a page/country correlation
  // that the export does not contain and that would read as a real finding.
  const slots: Array<{ path: string, i: number, of: number, key: number }> = []
  for (const path of exp.pages.keys()) {
    const of = counts.get(path) ?? 0
    for (let i = 0; i < of; i++)
      slots.push({ path, i, of, key: (i + 0.5) / of })
  }
  slots.sort((a, b) => a.key - b.key || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const total = slots.length
  const countries = allocate(exp.countries, total)
  const devices = allocate(exp.devices, total)
  const browsers = allocate(exp.browsers, total)
  const systems = allocate(exp.systems, total)
  const sources = allocate(exp.sources, total)

  // Pageviews follow visitors, so a path with more views per visitor keeps that
  // ratio - split exactly, never rounded per visitor, so the page's own total
  // survives the trip. Floored at one view each: a visitor with no pageview is
  // not a thing the dashboard can show, and it can only happen on an export
  // whose Pages row claims more people than views.
  const views = new Map<string, number[]>()
  for (const [path, { pageviews }] of exp.pages) {
    const of = counts.get(path) ?? 0
    if (of > 0)
      views.set(path, dealEvenly(Math.max(pageviews, of), of))
  }

  for (let k = 0; k < total; k++) {
    const slot = slots[k]
    // Spread across the range, not filled from the front. `i % days.length`
    // packs visitors into the first N days and leaves the tail of the range
    // empty, which reads as "traffic stopped" rather than "there were fewer
    // visitors than days". This lands them evenly end to end.
    const date = days[spreadIndex(slot.i, slot.of, days.length)]
    const source = normFathomSource(sources[k])
    const country = normCountry(countries[k])
    const device = normFathomDevice(devices[k])
    const browser = clip(browsers[k] || 'Unknown', 32)
    const os = clip(normOs(systems[k] || 'Unknown'), 32)
    const key = `${date}|${slot.path}|${source}|${country}|${device}|${browser}|${os}`
    const rec = records.get(key) ?? {
      date,
      path: clip(slot.path, 255),
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
    rec.pageviews += views.get(slot.path)![slot.i]
    records.set(key, rec)
  }
  return [...records.values()]
}

// --- assembling an upload ---------------------------------------------------
//
// The CLI reads a folder and a route reads a JSON body, but neither should own
// what a Fathom export MEANS. Both hand their files to `readFathomExport` and
// get back either an export or a sentence to show the person, so the two cannot
// drift on which files are required, what a bad one is called, or what the
// customer is told about it.

/** Everything about an upload that a clean-looking import would otherwise hide. */
export interface FathomImportNotes {
  /** Names from `FATHOM_FILES` that were not in the upload. */
  missing: string[]
  /** Names from `FATHOM_IGNORED_FILES` that were present and not read. */
  ignored: string[]
  /** `Summary.csv`'s filter count. Non-zero means the export is a subset. */
  filtersApplied: number
  /** `Summary.csv` People: the deduplicated figure every breakdown is written in. */
  people: number
  /** Sum of `Pages.csv` visitors, counting a reader of three pages three times. */
  rawVisitors: number
  /** What `reconcileVisitors` settled on. See it for why the two differ. */
  reconciledVisitors: number
}

/**
 * Assemble an export from its files.
 *
 * Keys may carry a leading folder; only the basename is matched. Returns an
 * error rather than throwing or exiting, because one of the two callers is an
 * HTTP handler and the other is a CLI, and a shared reader that calls
 * `process.exit` is a reader only one of them can use.
 */
export function readFathomExport(
  files: ReadonlyMap<string, string>,
): { export: FathomExport, notes: FathomImportNotes } | { error: string } {
  const byName = new Map<string, string>()
  for (const [name, text] of files) {
    const base = fathomBasename(name)
    if (base)
      byName.set(base, text)
  }

  const summary = byName.get('Summary.csv') ?? ''
  if (!summary)
    return { error: 'Summary.csv was not in the upload. Select every CSV from the unzipped Fathom export, not just one of them.' }

  const range = parseRange(summary)
  if (!range)
    return { error: 'Could not read the date range from Summary.csv. It should contain a cell like "2026-09-02 00:00:00 to 2026-09-08 16:02:04 (UTC)".' }

  const pagesCsv = byName.get('Pages.csv') ?? ''
  if (!pagesCsv)
    return { error: 'Pages.csv was not in the upload. It carries the visitor and page view counts every other file is a breakdown of, so there is nothing to import without it.' }

  // Pages.csv is the spine: every other file only splits its visitors by one
  // dimension, so an export without it has nothing to be a breakdown OF.
  const pageLines = pagesCsv.split(/\r?\n/).filter(l => l.trim() !== '')
  const pages = new Map<string, { visitors: number, pageviews: number }>()
  for (const line of pageLines.slice(1)) {
    const c = splitCsv(line)
    const path = (c[0] || '').trim()
    if (!path)
      continue
    const prev = pages.get(path)
    const visitors = toInt(c[1])
    const pageviews = toInt(c[2]) || visitors
    pages.set(path, {
      visitors: (prev?.visitors ?? 0) + visitors,
      pageviews: (prev?.pageviews ?? 0) + pageviews,
    })
  }
  if (!pages.size)
    return { error: 'Pages.csv has no data rows, so there is nothing to import.' }

  const totals = parseSummaryTotals(summary)
  const exported: FathomExport = {
    from: range.from,
    to: range.to,
    people: totals.people,
    pageviews: totals.pageviews,
    pages,
    countries: parseBreakdown(byName.get('Countries.csv') ?? ''),
    devices: parseBreakdown(byName.get('Device_Types.csv') ?? ''),
    browsers: parseBreakdown(byName.get('Browsers.csv') ?? ''),
    systems: parseBreakdown(byName.get('Operating_Systems.csv') ?? ''),
    sources: parseBreakdown(byName.get('Sources.csv') ?? ''),
  }

  const recon = reconcileVisitors(pages, totals.people)
  return {
    export: exported,
    notes: {
      missing: FATHOM_FILES.filter(name => !byName.has(name)),
      ignored: FATHOM_IGNORED_FILES.filter(name => byName.has(name)),
      filtersApplied: parseFiltersApplied(summary),
      people: totals.people,
      rawVisitors: recon.rawTotal,
      reconciledVisitors: recon.total,
    },
  }
}

/**
 * The rows an import will write, counted before any of them are.
 *
 * Derived from `reconcileVisitors` and not from the raw `Pages.csv` column, so
 * it agrees exactly with what `toRecords` goes on to produce. An estimate that
 * disagreed with the write would be worse than none: it would refuse imports
 * that fit and admit ones that do not.
 */
export function estimateRows(exp: FathomExport): { pageViews: number, sessions: number } {
  const { counts, total } = reconcileVisitors(exp.pages, exp.people)
  let pageViews = 0
  for (const [path, { pageviews }] of exp.pages) {
    const visitors = counts.get(path) ?? 0
    if (visitors > 0)
      pageViews += Math.max(pageviews, visitors)
  }
  return { pageViews, sessions: total }
}

/**
 * Every way this import is incomplete or approximate, named.
 *
 * A sibling of the GA importer's `importWarnings`, never an extension of it:
 * that one's copy is about paging through an open-ended API, and a Fathom
 * export is one fixed range in a file, so "import it in shorter periods" would
 * be advice the customer cannot act on. What they share is the rule, which is
 * that a partial import must never render as a clean one.
 */
export function fathomImportWarnings(notes: FathomImportNotes): string[] {
  const out: string[] = []
  const n = (v: number) => v.toLocaleString()

  if (notes.rawVisitors > notes.reconciledVisitors) {
    out.push(
      `Fathom counted ${n(notes.people)} people over this period, but its per page visitor counts add up to ${n(notes.rawVisitors)}, because someone who reads three pages is counted on each one. `
      + `We scaled the page counts back to ${n(notes.reconciledVisitors)} so your country, device, browser and source totals still match Fathom.`,
    )
  }
  if (notes.people > 0 && notes.reconciledVisitors > notes.people) {
    out.push(
      `This export lists more pages than people, so every page keeps one visitor and the import totals ${n(notes.reconciledVisitors)} visitors rather than ${n(notes.people)}.`,
    )
  }
  if (notes.missing.length) {
    out.push(
      `Missing from the upload, so imported traffic carries no value for those breakdowns: ${notes.missing.join(', ')}.`,
    )
  }
  if (notes.filtersApplied > 0) {
    out.push(
      'This export was taken with Fathom filters on, so the imported period holds a subset of your real traffic rather than all of it.',
    )
  }
  if (notes.ignored.length) {
    out.push(
      'Referrers, entry and exit pages, events and UTM campaigns are in a Fathom export but are not imported yet. Sub-country location is never imported, because this app only ever stores country.',
    )
  }
  return out
}
