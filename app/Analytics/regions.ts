/**
 * The disclosure floor for sub-country rows, and the ISO code they are written
 * in.
 *
 * ## Why regions get a floor when no other breakdown does
 *
 * `filters.ts` withholds a whole report when FILTERS narrowed a population past
 * the minimum, on the reasoning that "the disclosure comes from narrowing, not
 * from smallness". That is right for country: a row saying three people visited
 * from Iceland identifies nobody, because Iceland is four hundred thousand
 * people and three of them came.
 *
 * A subdivision is not that. It is already a narrowing — applied by where the
 * visitor lives rather than by a filter — and a state with two visitors on a
 * site with two thousand is a far smaller haystack than any country. So every
 * row under the minimum is held back and reported together as one bucket. The
 * traffic still counts; what is withheld is which state it came from.
 *
 * ## Why this is a module and not written twice
 *
 * Two callers need it: the `/api/sites/{id}/regions` endpoint and the dashboard
 * panel. Both are files that can import — the fold is in dashboard.stx's SERVER
 * block, not the client one — so there is no reason for two spellings of a rule
 * whose whole job is to be the same number in both places. A disagreement here
 * would show one figure in the panel and another through the API for the same
 * site on the same day.
 */

/** What a grouped region query hands back, before folding. */
import SUBDIVISIONS from './subdivisions.json'

export interface RegionCount {
  region: string | null
  views: number | string
  visitors: number | string
}

/** One row of the finished breakdown. `region` is '' on the Other bucket. */
export interface FoldedRegion {
  region: string
  views: number
  visitors: number
}

export interface FoldedRegions {
  rows: FoldedRegion[]
  /** The withheld rows, summed. `null` when nothing was under the floor. */
  other: { views: number, visitors: number } | null
  /** How many rows went into `other`, for copy that wants to say so. */
  withheld: number
}

/**
 * ISO 3166-2 as this app writes it: `US-CA`.
 *
 * The compound form is deliberate. A bare subdivision code is ambiguous across
 * countries and collides with the alpha-2 country codes — `CA` is California
 * here and Canada in the `country` column — so an unprefixed value would mix the
 * two in any query that touched both.
 */
export const REGION_CODE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/

/** `US-CA` -> `{ country: 'US', subdivision: 'CA' }`, or `null` if it is not one. */
export function splitRegion(code: string | null | undefined): { country: string, subdivision: string } | null {
  const value = String(code ?? '')
  if (!REGION_CODE.test(value))
    return null
  return { country: value.slice(0, 2), subdivision: value.slice(3) }
}

/**
 * Apply the floor, then take the top `limit`.
 *
 * IN THAT ORDER, and the order is the whole point. The rows under the minimum
 * have to be summed, so a limit applied first — in SQL, or here — would compute
 * the withheld total from the top twenty instead of from everything, and quietly
 * under-report it. Both callers therefore group without a LIMIT and cut here.
 * Bounded either way: there are about four thousand ISO subdivisions, and a site
 * only has rows for the ones it actually saw.
 *
 * A `floor` of 0 disables the fold, matching `minSegmentSize`, where only an
 * explicit 0 turns the guard off.
 */
export function foldRegions(rows: readonly RegionCount[], floor: number, limit: number): FoldedRegions {
  const kept: FoldedRegion[] = []
  let otherViews = 0
  let otherVisitors = 0
  let withheld = 0

  for (const row of rows) {
    const views = Number(row.views ?? 0)
    // Summed, so a visitor seen in two regions counts in both — the same
    // overcount every breakdown column already carries, and the reason a
    // breakdown's visitors never add up to the site's total.
    const visitors = Number(row.visitors ?? 0)
    const region = String(row.region ?? '')
    if (!region)
      continue
    if (floor > 0 && visitors < floor) {
      otherViews += views
      otherVisitors += visitors
      withheld++
      continue
    }
    kept.push({ region, views, visitors })
  }

  return {
    rows: kept.slice(0, limit),
    other: withheld > 0 ? { views: otherViews, visitors: otherVisitors } : null,
    withheld,
  }
}

/**
 * `US-CA` -> `California`, `PH-07` -> `Central Visayas`.
 *
 * ## Where the names come from
 *
 * `subdivisions.json` is a name -> code table per country, generated from the
 * DB-IP City Lite file so `geo.ts` can turn the English name that database
 * carries into an ISO code on the way in. Read the other way it is a code ->
 * name table, which is what a reader needs on the way out.
 *
 * The panel used to print the bare code, and the comment where it did explained
 * why: spelling a subdivision out "would mean shipping a table of every ISO
 * 3166-2 subdivision name — some four thousand of them". That table is already
 * shipped, and has been since region geo started working at all. `US-CA` at
 * least reads as California by luck; `PH-07` reads as nothing, and `CA` beside a
 * flag is equally the code for Canada.
 *
 * ## Why a name can be ambiguous, and which one wins
 *
 * DB-IP carries aliases, so 384 codes have more than one spelling — `AL-03` is
 * both `Elbasan` and `Elbasan County`, `DE-BW` both `Baden-Württemberg` and the
 * unaccented `Baden-Wurttemberg`. Reversing the map therefore needs a rule, and
 * the obvious one — shortest wins — picks the mangled German.
 *
 * So: the spelling with the most non-ASCII characters wins, and the shortest
 * breaks the tie. That is "prefer the properly accented name, then the plainest
 * form of it", which gives Baden-Württemberg, Berlin over State of Berlin,
 * Elbasan over Elbasan County, and Bicol over Bicol Region.
 *
 * Built once on first use: 194 countries and 3,234 subdivisions is not work to
 * repeat per row, and a dashboard that never opens the panel never pays for it.
 */
let subdivisionNames: Map<string, string> | null = null

function namesByCode(): Map<string, string> {
  if (subdivisionNames)
    return subdivisionNames

  // Accented spelling first, then the shortest, so the winner is deterministic
  // whatever order the table is in.
  const preferred = (a: string, b: string): string => {
    const accents = (s: string) => [...s].filter(c => c.charCodeAt(0) > 127).length
    if (accents(a) !== accents(b))
      return accents(a) > accents(b) ? a : b
    return a.length <= b.length ? a : b
  }

  const table = SUBDIVISIONS as Record<string, Record<string, string>>
  const built = new Map<string, string>()
  for (const [country, names] of Object.entries(table)) {
    for (const [name, code] of Object.entries(names)) {
      const key = `${country}-${code}`
      const held = built.get(key)
      built.set(key, held ? preferred(held, name) : name)
    }
  }

  subdivisionNames = built
  return built
}

/**
 * The English name for an ISO 3166-2 code, or null when the table has none.
 *
 * Null rather than a guess, and the caller keeps showing the code: a subdivision
 * the table does not know is still a real place the visitor came from, and a row
 * reading `PH-XX` is honest where an invented name would not be.
 */
export function subdivisionName(code: string | null | undefined): string | null {
  const parts = splitRegion(code)
  if (!parts)
    return null
  return namesByCode().get(`${parts.country}-${parts.subdivision}`) ?? null
}
