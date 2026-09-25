/**
 * City geolocation, and the region fix it depended on.
 *
 * City is an opt-in on the same terms as region: the install's ceiling has to
 * reach it, the site owner has to turn it on, and the database on disk has to
 * carry cities. The privacy-guardrails and privacy-config suites pin those
 * gates in the ingest. This file pins what the lookup itself produces.
 *
 * CI has no geolocation database (it is a monthly download), so the lookups run
 * against an injected reader returning records in DB-IP City Lite's real shape,
 * copied from the September 2026 file. That shape is the point: DB-IP carries
 * NO subdivision code, only an English name, and region geo read the code and
 * nothing else, so it could never have recorded a state with the database the
 * product ships. The same tests run against the real file in geo.test.ts
 * wherever one is installed.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CITY_VALUE, cityLabel, foldCities, splitCity } from '../../app/Analytics/cities'
import { CITY_NAME_MAX, cityFromIp, countryFromIp, geoHasCities, geoHasRegions, geoPermits, normalizeIp, regionFromIp, resetGeoCache, setGeoReaderForTests } from '../../app/Analytics/geo'
import SUBDIVISIONS from '../../app/Analytics/subdivisions.json'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** A DB-IP City Lite record: English subdivision name, no `iso_code`. */
function dbip(country: string, subdivision: string | null, city: string | null): Record<string, unknown> {
  return {
    country: { iso_code: country },
    ...(subdivision ? { subdivisions: [{ names: { en: subdivision } }] } : {}),
    ...(city ? { city: { names: { en: city } } } : {}),
    // Present in the real record and never to be read.
    location: { latitude: 32.88, longitude: -117.236 },
  }
}

const RECORDS: Record<string, Record<string, unknown>> = {
  // UCSD. The address the whole feature was asked for.
  '132.239.1.1': dbip('US', 'California', 'San Diego (La Jolla)'),
  '8.8.8.8': dbip('US', 'California', 'Mountain View'),
  '1.1.1.1': dbip('AU', 'New South Wales', 'Sydney'),
  '212.227.222.8': dbip('DE', 'Hesse', 'Frankfurt am Main'),
  '2001:4860:4860::8888': dbip('CA', 'Quebec', 'Montreal'),
  // A subdivision the generated table does not know: city still resolves,
  // prefixed with the country alone.
  '203.0.113.10': dbip('TW', 'Taiwan', 'Taipei'),
  // Country only, as in the country-level file.
  '203.0.113.11': { country: { iso_code: 'FR' } },
  // MaxMind's shape, which does carry the code.
  '203.0.113.12': { country: { iso_code: 'GB' }, subdivisions: [{ iso_code: 'ENG', names: { en: 'England' } }], city: { names: { en: 'London' } } },
  // Hostile names.
  '203.0.113.13': dbip('US', 'California', 'Evil:Town\u0000\n'),
  '203.0.113.14': dbip('US', 'California', 'X'.repeat(200)),
  '203.0.113.15': dbip('US', 'California', '   '),
  // Coordinates but no city: nothing to record.
  '203.0.113.16': dbip('US', 'California', null),
}

function install(): void {
  setGeoReaderForTests({ get: ip => (RECORDS[ip] as never) ?? null })
}

afterEach(() => {
  resetGeoCache()
})

describe('the region fix: DB-IP names become ISO codes', () => {
  test('a DB-IP record with no iso_code resolves to its state', () => {
    // The bug: this returned null for every address, so region geo recorded
    // nothing for every site that opted in.
    install()
    expect(regionFromIp('132.239.1.1')).toBe('US-CA')
    expect(regionFromIp('1.1.1.1')).toBe('AU-NSW')
    expect(regionFromIp('212.227.222.8')).toBe('DE-HE')
    expect(regionFromIp('2001:4860:4860::8888')).toBe('CA-QC')
    expect(geoHasRegions()).toBe(true)
  })

  test('a MaxMind record still uses the code it carries', () => {
    install()
    expect(regionFromIp('203.0.113.12')).toBe('GB-ENG')
  })

  test('a name the table does not know is no region, never a guess', () => {
    install()
    expect(regionFromIp('203.0.113.10')).toBeNull()
    expect(countryFromIp('203.0.113.10')).toBe('TW')
  })

  test('the table covers every US state and DC, with well-formed codes', () => {
    const table = SUBDIVISIONS as Record<string, Record<string, string>>
    expect(Object.keys(table.US).length).toBe(51)
    expect(table.US.California).toBe('CA')
    expect(table.US['District of Columbia']).toBe('DC')
    for (const [cc, names] of Object.entries(table)) {
      expect({ cc, ok: /^[A-Z]{2}$/.test(cc) }).toEqual({ cc, ok: true })
      for (const [name, code] of Object.entries(names))
        expect({ cc, name, ok: /^[A-Z0-9]{1,3}$/.test(code) }).toEqual({ cc, name, ok: true })
    }
  })
})

describe('cityFromIp', () => {
  test('San Diego resolves to San Diego, with its state', () => {
    install()
    expect(cityFromIp('132.239.1.1')).toBe('US-CA:San Diego')
    expect(cityFromIp('8.8.8.8')).toBe('US-CA:Mountain View')
    expect(cityFromIp('212.227.222.8')).toBe('DE-HE:Frankfurt am Main')
    expect(geoHasCities()).toBe(true)
  })

  test('the neighbourhood DB-IP puts in brackets is dropped', () => {
    // "San Diego (La Jolla)" is a district. Recording it would be finer than the
    // setting says, and would split one city into a hundred floored rows.
    install()
    expect(cityFromIp('132.239.1.1')).not.toContain('La Jolla')
    expect(cityFromIp('132.239.1.1')).not.toContain('(')
  })

  test('without a known region the country prefixes the city', () => {
    install()
    expect(cityFromIp('203.0.113.10')).toBe('TW:Taipei')
  })

  test('a country-only record has no city', () => {
    install()
    expect(countryFromIp('203.0.113.11')).toBe('FR')
    expect(cityFromIp('203.0.113.11')).toBeNull()
  })

  test('coordinates alone are never turned into anything', () => {
    install()
    expect(cityFromIp('203.0.113.16')).toBeNull()
  })

  test('separators and control characters cannot reach the column', () => {
    install()
    const v = cityFromIp('203.0.113.13')!
    expect(v).toBe('US-CA:Evil Town')
    expect(v.split(':').length).toBe(2)
  })

  test('names are capped so the value always fits varchar(100)', () => {
    install()
    const v = cityFromIp('203.0.113.14')!
    expect(v.length).toBeLessThanOrEqual(100)
    expect(v.slice(v.indexOf(':') + 1).length).toBe(CITY_NAME_MAX)
  })

  test('a blank name is no city', () => {
    install()
    expect(cityFromIp('203.0.113.15')).toBeNull()
  })

  test('every value it produces is one the dashboard can parse', () => {
    install()
    for (const ip of Object.keys(RECORDS)) {
      const v = cityFromIp(ip)
      if (v !== null)
        expect({ ip, v, ok: CITY_VALUE.test(v) && v.length <= 100 }).toEqual({ ip, v, ok: true })
    }
  })

  test('the addresses that never resolve a country never resolve a city', () => {
    install()
    for (const ip of ['', '0.0.0.0', '127.0.0.1', '::1', '1.2.3', 'not-an-ip'])
      expect({ ip, city: cityFromIp(ip) }).toEqual({ ip, city: null })
  })
})

describe('normalizeIp: the spellings proxies send', () => {
  test('ports, brackets and v4-mapped v6 are unwrapped', () => {
    expect(normalizeIp('203.0.113.7:51234')).toBe('203.0.113.7')
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(normalizeIp('::FFFF:203.0.113.7')).toBe('203.0.113.7')
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1')
    expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1')
    expect(normalizeIp('  8.8.8.8 ')).toBe('8.8.8.8')
  })

  test('a bare v6 address is left alone, not mistaken for v4:port', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1')
    expect(normalizeIp('::1')).toBe('::1')
  })

  test('each unwrapped form resolves like the bare address', () => {
    install()
    for (const ip of ['::ffff:132.239.1.1', '132.239.1.1:443'])
      expect({ ip, city: cityFromIp(ip) }).toEqual({ ip, city: 'US-CA:San Diego' })
    expect(cityFromIp('[2001:4860:4860::8888]:443')).toBe('CA-QC:Montreal')
  })

  test('junk is still refused after unwrapping', () => {
    install()
    for (const ip of ['::ffff:1.2.3', '1.2.3:80', '[not]:80'])
      expect({ ip, country: countryFromIp(ip) }).toEqual({ ip, country: null })
  })
})

describe('geoPermits ranks the levels', () => {
  test('a ceiling permits itself and everything coarser', () => {
    expect(geoPermits('city', 'city')).toBe(true)
    expect(geoPermits('city', 'region')).toBe(true)
    expect(geoPermits('region', 'region')).toBe(true)
    expect(geoPermits('region', 'city')).toBe(false)
    expect(geoPermits('country', 'region')).toBe(false)
    expect(geoPermits('none', 'country')).toBe(false)
  })

  test('an unknown ceiling permits nothing', () => {
    // A typo in config must fail closed, not open.
    expect(geoPermits('citty', 'region')).toBe(false)
    expect(geoPermits('', 'country')).toBe(false)
  })
})

describe('the city value format', () => {
  test('splits into its parts', () => {
    expect(splitCity('US-CA:San Diego')).toEqual({ country: 'US', region: 'US-CA', subdivision: 'CA', name: 'San Diego' })
    expect(splitCity('TW:Taipei')).toEqual({ country: 'TW', region: null, subdivision: null, name: 'Taipei' })
  })

  test('rejects anything that is not one', () => {
    for (const bad of ['San Diego', 'US-CA', 'us-ca:San Diego', 'US-CA:', ':San Diego', 'USA:X', null, undefined])
      expect({ bad, out: splitCity(bad as string) }).toEqual({ bad, out: null })
  })

  test('reads as the city with its state', () => {
    expect(cityLabel('US-CA:San Diego')).toBe('San Diego, CA')
    expect(cityLabel('TW:Taipei')).toBe('Taipei')
    // Unparseable values render as themselves rather than as something invented.
    expect(cityLabel('weird')).toBe('weird')
  })

  test('two towns of the same name stay two rows', () => {
    expect(cityLabel('US-IL:Springfield')).not.toBe(cityLabel('US-MA:Springfield'))
  })
})

describe('the city disclosure floor', () => {
  test('small towns are folded into Other, and the floor runs before the limit', () => {
    const rows = [
      { city: 'US-CA:San Diego', views: 40, visitors: 20 },
      { city: 'US-CA:Los Angeles', views: 12, visitors: 6 },
      ...Array.from({ length: 10 }, (_, i) => ({ city: `US-WY:Town ${i}`, views: 2, visitors: 1 })),
    ]
    const out = foldCities(rows, 5, 1)
    expect(out.rows).toEqual([{ city: 'US-CA:San Diego', views: 40, visitors: 20 }])
    expect(out.withheld).toBe(10)
    expect(out.other).toEqual({ views: 20, visitors: 10 })
  })

  test('null cities are dropped, never folded', () => {
    const out = foldCities([{ city: null, views: 99, visitors: 99 }], 5, 8)
    expect(out.rows).toEqual([])
    expect(out.other).toBeNull()
  })
})

describe('the schema, the ingest and the dashboard are wired to it', () => {
  const routes = read('routes/analytics.ts')
  const view = read('resources/views/dashboard.stx')

  test('the migration is idempotent and backfills nothing', () => {
    const sql = read('database/migrations/0000000054-add-opt-in-city-geo.sql')
    expect(sql).toContain('"city" varchar(100)')
    for (const stmt of sql.split(';').filter(s => /ALTER TABLE|CREATE INDEX/.test(s)))
      expect(stmt).toMatch(/IF NOT EXISTS/)
    expect(sql).not.toMatch(/UPDATE\s+"?sites"?\s+SET/i)
  })

  test('the models declare the columns at the migrated width', () => {
    for (const file of ['app/Models/PageView.ts', 'app/Models/Session.ts']) {
      const src = read(file)
      expect({ file, declared: src.includes('city: { fillable: true') && src.includes('.max(100)') }).toEqual({ file, declared: true })
    }
    expect(read('app/Models/Site.ts')).toContain('city_geo: {')
  })

  test('both inserts carry the city', () => {
    expect([...routes.matchAll(/^\s*city: city \?\? null,$/gm)].length).toBe(2)
  })

  test('the endpoint and the filter exist', () => {
    expect(routes).toContain("topDimension('/api/sites/{siteId}/cities', 'city', 'cities', { floorRows: true })")
    expect(read('app/Analytics/filters.ts')).toContain("city: 'city'")
    expect(routes).toContain('geoCity: geoHasCities()')
  })

  test('the dashboard filters, groups and floors cities', () => {
    expect(view).toContain("city: { col: 'city', label: 'City' }")
    expect(view).toMatch(/SESSION_DIMENSIONS = new Set\(\[[^\]]*'city'/)
    expect(view).toContain('foldCities(cities, REGION_FLOOR')
    expect(view).toMatch(/@if \(cityGeo\)[\s\S]{0,300}<BreakdownPanel :title="cityTitle"/)
  })

  test('the city toggle follows the server, like the region one', () => {
    const toggle = view.slice(view.indexOf('<div class="font-semibold text-sm">Record city</div>'))
    const input = toggle.slice(toggle.indexOf('<input type="checkbox"'), toggle.indexOf('<input type="checkbox"') + 200)
    expect(input).toContain(':checked="cityGeoOn()"')
    expect(input).toContain('@change="toggleCityGeo"')
    expect(input).not.toContain('x-model')
    const fn = view.slice(view.indexOf('async function toggleCityGeo'), view.indexOf('// --- Fathom import'))
    expect(fn).toMatch(/if \(res\.ok\) \{\s*\n\s*cityGeoOn\.set\(next\)/)
  })

  test('both toggles are seeded from the server', () => {
    // A declared client payload bridges only the names it lists. Missing, the
    // client read `typeof regionGeo` as undefined and every box loaded unticked
    // on a site that had the setting on.
    const decl = /defineClientPayload\(\{([^}]*)\}\)/.exec(view)![1]
    expect(decl).toContain('regionGeo')
    expect(decl).toContain('cityGeo')
  })
})
