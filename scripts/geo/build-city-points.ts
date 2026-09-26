/**
 * Build `storage/geo/city-points.json`: where each city and region IS, so the
 * live map can put a visitor's dot on Santa Monica rather than on the middle
 * of the United States.
 *
 * ## What this is, and what it is not
 *
 * A gazetteer: public place names to the rough centre of the place. It is
 * built once, offline, from every record in the DB-IP City Lite file, and
 * keyed exactly the way page views are (`US-CA:Santa Monica`, `US-CA`) by the
 * same functions the ingest uses (`cityOf`, `regionOfRecord`).
 *
 * No visitor is ever located by coordinates. The ingest still records a city's
 * name and nothing finer, and the map looks a name up here only for places
 * that already cleared the site's disclosure floor. The coordinates are those
 * of the place: every record for a city is averaged into one point and rounded
 * to 0.1 degree, about 11km, so a big city's many records collapse to its
 * middle and no finer position survives.
 *
 * A region's point is the mean of its cities' points, which lands inside the
 * state for any state with more than one city.
 *
 * ## Running it
 *
 *   bun scripts/geo/build-city-points.ts storage/geo/dbip-country-lite.mmdb storage/geo/city-points.json
 *
 * The deploy runs it right after fetching the database. A country-level
 * database has no cities, so it writes nothing and the map falls back to
 * country centres.
 */
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { cityOf } from '../../app/Analytics/geo'
import { openTree } from './mmdb-tree'

type Sum = { lat: number, lon: number, n: number }

const round = (x: number) => Math.round(x * 10) / 10

function add(map: Map<string, Sum>, key: string, lat: number, lon: number): void {
  const s = map.get(key)
  if (s) {
    s.lat += lat
    s.lon += lon
    s.n++
  }
  else {
    map.set(key, { lat, lon, n: 1 })
  }
}

function main(): void {
  const [src, out] = process.argv.slice(2)
  if (!src || !out)
    throw new Error('usage: bun scripts/geo/build-city-points.ts <dbip-city-lite.mmdb> <out.json>')

  const started = performance.now()
  const tree = openTree(src)
  if (!tree.databaseType.includes('City')) {
    console.log(`${src} is ${tree.databaseType}: no cities, so no points. The map uses country centres.`)
    return
  }

  let records = 0
  const cities = new Map<string, Sum>()
  for (const rec of tree.records()) {
    records++
    const lat = Number(rec.location?.latitude)
    const lon = Number(rec.location?.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      continue
    const city = cityOf(rec)
    if (city)
      add(cities, city, lat, lon)
  }

  const cityPoints: Record<string, [number, number]> = {}
  const regions = new Map<string, Sum>()
  for (const [key, s] of cities) {
    const point: [number, number] = [round(s.lat / s.n), round(s.lon / s.n)]
    cityPoints[key] = point
    // `US-CA:Santa Monica` -> `US-CA`. A city filed under its country only
    // (`SG:Singapore`) has no region to contribute to.
    const place = key.slice(0, key.indexOf(':'))
    if (place.includes('-'))
      add(regions, place, point[0], point[1])
  }
  const regionPoints: Record<string, [number, number]> = {}
  for (const [key, s] of regions)
    regionPoints[key] = [round(s.lat / s.n), round(s.lon / s.n)]

  writeFileSync(out, JSON.stringify({ built: new Date().toISOString(), source: tree.databaseType, cities: cityPoints, regions: regionPoints }))
  console.log(`${Object.keys(cityPoints).length} cities, ${Object.keys(regionPoints).length} regions from ${records} records in ${((performance.now() - started) / 1000).toFixed(1)}s -> ${out}`)
}

main()
