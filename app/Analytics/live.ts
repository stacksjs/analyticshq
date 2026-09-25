/**
 * Where the people on the site right now are.
 *
 * One function, two callers: the dashboard's first render and the
 * /api/sites/{id}/realtime endpoint the dashboard polls every 15 seconds. Both
 * go through here so the strip cannot say one thing on load and another a
 * quarter of a minute later.
 *
 * ## The floor, and what happens under it
 *
 * A live list is the sharpest version of the problem the disclosure floor
 * exists for: "one visitor, right now, from Springfield" points at a person far
 * more directly than a monthly breakdown does. So a place finer than a country
 * is named only when it has at least `floor` live visitors, the same per-site
 * floor every region and city report uses (`minSegmentSizeFor`). A place under
 * it is not hidden. It is rolled up into its country, which is where this
 * product has always said location stops being identifying. A site whose
 * operator set its floor to 0 sees every city by name.
 */
import { countryName, flag } from '../Support/dashboard-format'
import { cityLabel, splitCity } from './cities'
import { splitRegion } from './regions'

/** One grouped row from page_views over the live window. */
export interface LivePlaceRow {
  country: string | null
  region: string | null
  city: string | null
  visitors: number | string
}

/** What the strip draws. `flag` is the emoji, built here so the client needs no table. */
export interface LiveLocation {
  key: string
  country: string
  flag: string
  label: string
  visitors: number
}

export interface LiveLocations {
  locations: LiveLocation[]
  /** Live visitors in places past `limit`, summed. */
  more: number
  /** Live visitors with no country at all (no geo database, a private address). */
  unknown: number
}

/**
 * Group, apply the floor, sort, cut.
 *
 * `total` is the live count the caller already has (distinct visitors in the
 * window). Visitors not accounted for by any row are reported as `unknown`, so
 * the numbers on the strip always add up to the count beside them.
 */
export function liveLocations(
  rows: readonly LivePlaceRow[],
  floor: number,
  total: number,
  limit = 6,
): LiveLocations {
  const places = new Map<string, LiveLocation>()
  const add = (key: string, country: string, label: string, visitors: number): void => {
    const hit = places.get(key)
    if (hit)
      hit.visitors += visitors
    else places.set(key, { key, country, flag: flag(country), label, visitors })
  }

  let placed = 0
  for (const row of rows) {
    const visitors = Number(row.visitors ?? 0)
    const country = String(row.country ?? '').toUpperCase()
    if (!visitors || !/^[A-Z]{2}$/.test(country))
      continue
    placed += visitors
    const named = floor <= 0 || visitors >= floor
    const city = row.city && splitCity(row.city)
    const region = row.region && splitRegion(row.region)
    if (named && city)
      add(`city:${row.city}`, country, cityLabel(row.city), visitors)
    else if (named && region)
      add(`region:${row.region}`, country, `${region.subdivision}, ${countryName(country)}`, visitors)
    else
      add(`country:${country}`, country, countryName(country), visitors)
  }

  const sorted = [...places.values()].sort((a, b) => b.visitors - a.visitors || a.label.localeCompare(b.label))
  const shown = sorted.slice(0, limit)
  return {
    locations: shown,
    more: sorted.slice(limit).reduce((n, l) => n + l.visitors, 0),
    unknown: Math.max(0, Math.round(Number(total) || 0) - placed),
  }
}
