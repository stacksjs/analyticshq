/**
 * Where a named place is, for the live map's dots.
 *
 * Reads the gazetteer scripts/geo/build-city-points.ts writes at deploy time
 * (storage/geo/city-points.json): city and region values, keyed exactly as
 * page views store them, to the rounded centre of the place. See that script
 * for why this locates places and never people.
 *
 * Loaded on first use, not at boot: most requests never draw a map, and the
 * file is a few megabytes. A missing or unreadable file is not an error. The
 * dots fall back to country centres, which is what the map did before, and
 * the load is retried now and then so a file that arrives later is picked up.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

export type LatLon = [number, number]

interface Gazetteer {
  cities: Record<string, LatLon>
  regions: Record<string, LatLon>
}

const RETRY_MS = 10 * 60 * 1000
let loaded: Gazetteer | null = null
let failedAt = 0

export function cityPointsPath(env: Record<string, string | undefined> = process.env): string {
  return env.ANALYTICSHQ_CITY_POINTS?.trim() || join(import.meta.dir, '../../storage/geo/city-points.json')
}

function gazetteer(): Gazetteer | null {
  if (loaded)
    return loaded
  if (failedAt && Date.now() - failedAt < RETRY_MS)
    return null
  try {
    const data = JSON.parse(readFileSync(cityPointsPath(), 'utf8'))
    loaded = { cities: data?.cities ?? {}, regions: data?.regions ?? {} }
    return loaded
  }
  catch {
    failedAt = Date.now()
    return null
  }
}

/** Test seam, and for a deploy that swaps the file under a running process. */
export function resetCityPoints(data: Gazetteer | null = null): void {
  loaded = data
  failedAt = 0
}

/** The centre of a city (`US-CA:Santa Monica`) or region (`US-CA`), or null. */
export function pointOf(key: { city?: string | null, region?: string | null }): LatLon | null {
  const g = gazetteer()
  if (!g)
    return null
  const point = key.city ? g.cities[key.city] : key.region ? g.regions[key.region] : undefined
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) ? point : null
}
