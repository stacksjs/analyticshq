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
