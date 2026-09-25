/**
 * The city column's value format, its label, and its disclosure floor.
 *
 * ## The value
 *
 * `US-CA:San Diego` — the place the city sits in, a colon, then its English
 * name. The place is the ISO 3166-2 region when the database has one for that
 * country and the bare ISO 3166-1 country when it does not (`SG:Singapore`).
 * `app/Analytics/geo.ts` writes it; this module reads it back.
 *
 * The prefix is what keeps the column honest. A bare name merges every
 * Springfield into one row and lets a filter on Paris, France match Paris,
 * Texas. With the prefix the value is globally unique, so `GROUP BY city` and
 * `?city=` both mean exactly one place.
 *
 * ## The floor
 *
 * Cities get the same per-row floor regions do, and need it more: a region is
 * already a narrowing by where a visitor lives, and a city is a much narrower
 * one. A town with two visitors on a site with two thousand is a small enough
 * haystack to point at a person, so every row under the minimum is held back
 * and summed into one "Other" bucket. The traffic still counts; what is
 * withheld is which town it came from.
 *
 * The fold itself is `foldRegions`, not a second implementation. It knows
 * nothing about regions beyond the field name, and two spellings of one
 * threshold is how the panel and the API end up disagreeing about the same day.
 */

import type { RegionCount } from './regions'
import { foldRegions } from './regions'

/** `US-CA:San Diego`, `SG:Singapore`. The place code, a colon, a name. */
export const CITY_VALUE = /^([A-Z]{2}(?:-[A-Z0-9]{1,3})?):(\S.{0,79})$/

/** `US-CA:San Diego` -> `{ country: 'US', region: 'US-CA', subdivision: 'CA', name: 'San Diego' }`. */
export function splitCity(value: string | null | undefined): { country: string, region: string | null, subdivision: string | null, name: string } | null {
  const m = CITY_VALUE.exec(String(value ?? ''))
  if (!m)
    return null
  const place = m[1]
  const region = place.length > 2 ? place : null
  return {
    country: place.slice(0, 2),
    region,
    subdivision: region ? region.slice(3) : null,
    name: m[2],
  }
}

/**
 * Countries whose state or province codes people actually write after a city:
 * "San Diego, CA", "Toronto, ON", "Sydney, NSW". Elsewhere the ISO code is not
 * how anyone writes an address ("Berlin, BE", "London, ENG"), and the flag beside
 * the row already says the country.
 */
const CODED_SUBDIVISIONS = new Set(['US', 'CA', 'AU'])

/**
 * What a row reads as: `San Diego, CA`, or `Berlin`.
 *
 * Where the subdivision code is conventional it rides along, because it is what
 * tells two towns of the same name apart: a list saying "Springfield" twice
 * would be useless. The caller adds the flag, since inside a country filter
 * every row would repeat it. The stored value keeps the full code either way,
 * so filtering and grouping never depend on how a row is labelled.
 */
export function cityLabel(value: string | null | undefined): string {
  const parts = splitCity(value)
  if (!parts)
    return String(value ?? '')
  return parts.subdivision && CODED_SUBDIVISIONS.has(parts.country) ? `${parts.name}, ${parts.subdivision}` : parts.name
}

/** What a grouped city query hands back, before folding. */
export interface CityCount {
  city: string | null
  views: number | string
  visitors: number | string
}

export interface FoldedCities {
  rows: Array<{ city: string, views: number, visitors: number }>
  other: { views: number, visitors: number } | null
  withheld: number
}

/**
 * Apply the floor, then take the top `limit` — in that order, for the reason
 * `foldRegions` gives: the withheld total has to be summed from every row, not
 * from the ones a limit happened to keep.
 */
export function foldCities(rows: readonly CityCount[], floor: number, limit: number): FoldedCities {
  const asRegions: RegionCount[] = rows.map(r => ({ region: r.city, views: r.views, visitors: r.visitors }))
  const folded = foldRegions(asRegions, floor, limit)
  return {
    rows: folded.rows.map(r => ({ city: r.region, views: r.views, visitors: r.visitors })),
    other: folded.other,
    withheld: folded.withheld,
  }
}
