/**
 * Build `app/Analytics/subdivisions.json`: DB-IP subdivision NAMES -> ISO 3166-2.
 *
 * ## Why this exists
 *
 * DB-IP's City Lite database carries no subdivision codes at all. A record for
 * a Californian address has `subdivisions: [{ names: { en: 'California' } }]`
 * and nothing else, so `regionFromIp`, which read `subdivisions[0].iso_code`,
 * returned null for every address on earth with the one database the product
 * supports. Region geo shipped, passed every test, and could never have
 * recorded a single state.
 *
 * The fix is a lookup table from (country, English name) to the ISO code, and
 * this script generates it from three public datasets, in order of trust:
 *
 *  1. `iso-3166` — the ISO names themselves, often in the local language
 *     ("Bayern", "Noord-Holland").
 *  2. `iso3166-2-db` — English names and Wikipedia titles from Wikidata, which
 *     is where DB-IP's exonyms come from ("Bavaria", "North Holland").
 *  3. `country-region-data` — a second English source, used only when its code
 *     is a real ISO 3166-2 code.
 *
 * plus {@link ALIASES} for the high-traffic names none of them spell the way
 * DB-IP does. Every code is checked against the ISO list before it is written,
 * and a name that matches two codes equally well is left out rather than
 * guessed: no region is an honest answer, the wrong state is not.
 *
 * ## Running it
 *
 *   bun add --no-save iso-3166 iso3166-2-db country-region-data
 *   bun scripts/geo/build-subdivisions.ts path/to/dbip-city-lite.mmdb
 *
 * Re-run when DB-IP renames something. Names that stop matching degrade to "no
 * region" for those visitors, never to an error.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { openTree } from './mmdb-tree'

/**
 * DB-IP spellings no dataset above matches, keyed `CC:Name`. Each was checked by
 * hand against the ISO 3166-2 list. Ambiguous DB-IP names (a city and the
 * province around it sharing a name) are resolved to the level DB-IP uses for
 * its first subdivision in that country.
 */
const ALIASES: Record<string, string> = {
  'AR:Buenos Aires': 'AR-B',
  'AR:Buenos Aires F.D.': 'AR-C',
  'AZ:Baki': 'AZ-BA',
  'BG:Sofia-grad': 'BG-22',
  'BH:Manama': 'BH-13',
  'BY:Minsk': 'BY-MI',
  'BY:Minsk City': 'BY-HM',
  'CH:Basel-City': 'CH-BS',
  'CH:Grisons': 'CH-GR',
  'CH:Saint Gall': 'CH-SG',
  'CL:O\'Higgins Region': 'CL-LI',
  'CZ:Central Bohemia': 'CZ-20',
  'CZ:Moravskoslezský': 'CZ-80',
  'CZ:Prague': 'CZ-10',
  'CZ:South Moravian': 'CZ-64',
  'DK:Capital Region': 'DK-84',
  'DK:Central Jutland': 'DK-82',
  'DK:South Denmark': 'DK-83',
  'DO:Nacional': 'DO-01',
  'ES:Balearic Islands': 'ES-IB',
  'ES:Castille and León': 'ES-CL',
  'ES:Castille-La Mancha': 'ES-CM',
  'ES:La Rioja': 'ES-RI',
  'ES:Murcia': 'ES-MC',
  'FR:Bourgogne': 'FR-BFC',
  'FR:New Aquitaine': 'FR-NAQ',
  'FR:Rhône-Alpes': 'FR-ARA',
  'HR:City of Zagreb': 'HR-21',
  'HR:Zagreb': 'HR-01',
  'ID:Jakarta': 'ID-JK',
  'IR:Tehran': 'IR-23',
  'IT:The Marches': 'IT-57',
  'KZ:Almaty': 'KZ-75',
  'MA:Marrakesh-Safi': 'MA-07',
  // Viken until Norway's 2024 split, which the ISO list this validates against
  // has not caught up with yet (NO-31/NO-32). Regenerate once it has.
  'NO:Akershus': 'NO-30',
  'NO:Østfold': 'NO-30',
  'PL:Lower Silesia': 'PL-02',
  'PL:Mazovia': 'PL-14',
  'PL:Podlasie': 'PL-20',
  'PL:Pomerania': 'PL-22',
  'PL:Silesia': 'PL-24',
  'PL:Subcarpathia': 'PL-18',
  'PL:Warmia-Masuria': 'PL-28',
  'PL:West Pomerania': 'PL-32',
  'QA:Baladiyat ad Dawhah': 'QA-DA',
  'RU:Moscow': 'RU-MOW',
  'RU:St.-Petersburg': 'RU-SPE',
  'SA:Mecca Region': 'SA-02',
  'UA:Odesa': 'UA-51',
  'UZ:Tashkent': 'UZ-TK',
  'UZ:Tashkent Region': 'UZ-TO',
  'VN:Ho Chi Minh City (HCMC)': 'VN-SG',
}

/** Words that decorate a subdivision name without identifying it. */
const GENERIC = /\b(?:state|province|provincia|region|regione|prefecture|county|governorate|oblast|department|departement|district|municipality|autonomous|community|republic|voivodeship|of|the|de|del|la|le|du|des|city|capital|territory|federal|metropolitan|special|administrative|emirate|parish|canton|kanton|land|free|and)\b/g

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .replace(GENERIC, ' ').replace(/\s+/g, ' ').trim()
}

/** One region from iso3166-2-db's `i18n/en.json`, with the fields this reads. */
interface WikidataRegion { cc: string, iso: string, name: string, wikipedia: string | null }

const field = (o: object, key: string): unknown => (key in o ? Reflect.get(o, key) : undefined)

/**
 * iso3166-2-db's English names, flattened. The file is
 * `{ [cc]: { regions: [{ iso, name, reference: { wikipedia } }] } }`; anything
 * not shaped like that is skipped rather than trusted.
 */
function wikidataRegions(json: unknown): WikidataRegion[] {
  const out: WikidataRegion[] = []
  if (typeof json !== 'object' || json === null)
    return out
  for (const [cc, country] of Object.entries(json)) {
    const regions = typeof country === 'object' && country !== null ? field(country, 'regions') : null
    if (!Array.isArray(regions))
      continue
    for (const r of regions) {
      if (typeof r !== 'object' || r === null)
        continue
      const iso = field(r, 'iso')
      const name = field(r, 'name')
      if (typeof iso !== 'string' || !iso || typeof name !== 'string')
        continue
      const ref = field(r, 'reference')
      const wp = typeof ref === 'object' && ref !== null ? field(ref, 'wikipedia') : null
      out.push({ cc, iso, name, wikipedia: typeof wp === 'string' ? wp : null })
    }
  }
  return out
}

/** Every distinct (country, first-subdivision English name) in the database. */
function subdivisionsIn(mmdbPath: string): Array<[string, string]> {
  const tree = openTree(mmdbPath)
  if (!tree.databaseType.includes('City'))
    throw new Error(`${mmdbPath} is ${tree.databaseType}, not a City database`)
  const pairs = new Map<string, [string, string]>()
  for (const d of tree.records()) {
    const cc = d.country?.iso_code
    const name = d.subdivisions?.[0]?.names?.en
    if (typeof cc === 'string' && typeof name === 'string')
      pairs.set(`${cc}:${name}`, [cc, name])
  }
  return [...pairs.values()]
}

async function main(): Promise<void> {
  const mmdb = process.argv[2]
  if (!mmdb)
    throw new Error('usage: bun scripts/geo/build-subdivisions.ts <dbip-city-lite.mmdb>')

  const { iso31662 } = await import('iso-3166')
  const { allCountries } = await import('country-region-data')
  const en = wikidataRegions(JSON.parse(readFileSync(join(process.cwd(), 'node_modules/iso3166-2-db/i18n/en.json'), 'utf8')))

  const valid = new Set<string>(iso31662.map(e => e.code))
  // Exact names and normalized names are indexed apart, so "Moscow" (the city)
  // and "Moscow Oblast" (normalized to "moscow") are not the same candidate.
  const exact = new Map<string, Map<string, number>>()
  const loose = new Map<string, Map<string, number>>()
  const add = (cc: string, name: string, code: string, pri: number): void => {
    if (!valid.has(code) || !name.trim())
      return
    for (const [idx, key] of [[exact, name.toLowerCase().trim()], [loose, norm(name)]] as const) {
      if (!key)
        continue
      const k = `${cc}:${key}`
      const m = idx.get(k) ?? new Map<string, number>()
      m.set(code, Math.min(m.get(code) ?? 9, pri))
      idx.set(k, m)
    }
  }

  for (const e of iso31662) {
    const cc = e.code.slice(0, 2)
    const pri = e.parent === cc ? 1 : 3
    for (const part of e.name.split(/\s*[/;]\s*|\s*\[[a-z-]+\]\s*/))
      add(cc, part, e.code, pri)
    add(cc, e.name.split(',')[0], e.code, pri)
  }
  for (const { cc, iso, name, wikipedia } of en) {
    add(cc, name, `${cc}-${iso}`, 1)
    if (wikipedia?.startsWith('en:'))
      add(cc, wikipedia.slice(3).replace(/_/g, ' ').replace(/\s*\(.*\)\s*$/, '').split(',')[0], `${cc}-${iso}`, 2)
  }
  for (const [, cc, regions] of allCountries) {
    for (const [name, short] of regions)
      if (short)
        add(cc, name, `${cc}-${short}`, 2)
  }

  const out: Record<string, Record<string, string>> = {}
  const unmatched: string[] = []
  for (const [cc, name] of subdivisionsIn(mmdb)) {
    let code: string | undefined = ALIASES[`${cc}:${name}`]
    if (code && !valid.has(code))
      throw new Error(`alias ${cc}:${name} -> ${code} is not an ISO 3166-2 code`)
    if (!code) {
      const cands = exact.get(`${cc}:${name.toLowerCase().trim()}`) ?? loose.get(`${cc}:${norm(name)}`)
      if (cands) {
        const best = Math.min(...cands.values())
        const top = [...cands].filter(([, p]) => p === best).map(([c]) => c)
        if (top.length === 1)
          code = top[0]
      }
    }
    if (!code) {
      unmatched.push(`${cc}:${name}`)
      continue
    }
    ;(out[cc] ??= {})[name] = code.slice(3)
  }

  // Sorted, so a regeneration diffs as the names that changed and nothing else.
  const sorted: Record<string, Record<string, string>> = {}
  for (const cc of Object.keys(out).sort())
    sorted[cc] = Object.fromEntries(Object.entries(out[cc]).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(join(import.meta.dir, '../../app/Analytics/subdivisions.json'), `${JSON.stringify(sorted, null, 1)}\n`)
  const mapped = Object.values(sorted).reduce((n, o) => n + Object.keys(o).length, 0)
  console.log(`Mapped ${mapped} subdivision names, ${unmatched.length} left unmatched (they record no region).`)
}

await main()
