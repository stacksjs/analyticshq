/**
 * The world-map panel.
 *
 * Two things are being defended here, and they are different in kind.
 *
 * The first is drift. ts-maps is a browser library and this app has no client
 * bundler, so the only way to use one is to build it into `public/vendor/` by
 * hand. A hand-vendored file silently stops matching the dependency it came
 * from — the same failure mode that let the homepage advertise a renamed npm
 * package for seven weeks (tests/unit/install.test.ts).
 *
 * The second is that a map is a large third-party engine on a privacy product's
 * dashboard. The vendored bundle carries default endpoint strings for geocoding,
 * routing and tile services it ships with (api.mapbox.com, maps.googleapis.com,
 * nominatim.openstreetmap.org). We never construct those services and never add
 * a tile layer, so nothing is requested — verified in a real browser, where
 * rendering the map produced exactly four requests, all same-origin, and zero
 * off-origin ones. These tests pin the code paths that keep that true.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const bundle = join(root, 'public/vendor/ts-maps.js')
const geojson = join(root, 'public/vendor/world-countries.geojson')
const dashboard = readFileSync(join(root, 'resources/views/dashboard.stx'), 'utf8')

/** The map's client script, bounded by its own script tag. */
function mapScript(): string {
  const i = dashboard.indexOf('data-country-map')
  expect(i, 'the map panel is gone').toBeGreaterThan(-1)
  const start = dashboard.indexOf('<script type="module">', i)
  expect(start, 'the map init script is gone').toBeGreaterThan(-1)
  return dashboard.slice(start, dashboard.indexOf('</scr' + 'ipt>', start))
}

describe('the vendored bundle stays in step with the dependency', () => {
  test('both vendored assets are committed', () => {
    // Referenced by absolute path from the dashboard. If either is missing the
    // panel silently does nothing, because every failure there is swallowed.
    expect({ bundle: existsSync(bundle), geojson: existsSync(geojson) })
      .toEqual({ bundle: true, geojson: true })
  })

  test('the bundle was built from the ts-maps that is installed now', () => {
    // Compares the hash of the BUILD INPUT, recorded at vendor time, against the
    // input as it stands.
    //
    // Not the version string: ts-maps 0.3.2 still reports 0.3.1 from its own
    // internal constant, so that marker cannot see an upgrade at all.
    //
    // And not the built output either — that was the first attempt and it failed
    // in CI while passing locally. `bun build --minify` differs between bun
    // versions, CI runs `bun-version: latest`, so byte-comparing the artifact
    // pins it to whichever bun happened to build it and breaks on every bun
    // release. The input hash is stable across all of that and still catches the
    // thing that matters.
    //
    // Failing here means ts-maps moved without re-vendoring. Run
    // `bun run vendor:map`; do not edit this test.
    const recorded = readFileSync(join(root, 'public/vendor/ts-maps.source-sha256'), 'utf8').trim()
    const actual = createHash('sha256')
      .update(readFileSync(join(root, 'node_modules/ts-maps/dist/index.js')))
      .digest('hex')
    expect({ recorded }).toEqual({ recorded: actual })
  })

  test('the vendored bundle is a real ts-maps build, not a stub', () => {
    // The input hash cannot see a hand-edited or truncated output, so assert the
    // artifact still looks like what it claims to be.
    const src = readFileSync(bundle, 'utf8')
    expect(src.length).toBeGreaterThan(100_000)
    for (const symbol of ['TsMap', 'GeoJSON', 'EPSG4326'])
      expect({ symbol, present: src.includes(symbol) }).toEqual({ symbol, present: true })
  })

  test('package.json can regenerate it', () => {
    // The command named in the failure above has to exist.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['vendor:map']).toContain('public/vendor/ts-maps.js')
    expect(pkg.dependencies['ts-maps']).toBeTruthy()
  })
})

describe('the map data matches the column it is keyed on', () => {
  const world = JSON.parse(readFileSync(geojson, 'utf8')) as {
    features: { id: string, geometry: { type: string, coordinates: any } }[]
  }

  test('every feature is keyed by an ISO alpha-2 code', () => {
    // page_views.country is varchar(2) and app/Analytics/country.ts upper-cases
    // everything it writes. A feature keyed any other way is simply never shaded.
    expect(world.features.length).toBeGreaterThan(150)
    for (const f of world.features)
      expect({ id: f.id, ok: /^[A-Z]{2}$/.test(f.id) }).toEqual({ id: f.id, ok: true })
  })

  test('the countries that carry real traffic are present', () => {
    const ids = new Set(world.features.map(f => f.id))
    for (const code of ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'IN', 'JP', 'BR', 'NL', 'ZA', 'KR', 'SE', 'IE'])
      expect({ code, present: ids.has(code) }).toEqual({ code, present: true })
  })

  test('city-states are absent, and the panel says so rather than hiding it', () => {
    // Natural Earth's 110m boundaries omit countries too small to draw at that
    // scale. Singapore and Hong Kong are ordinary traffic sources for these
    // sites, so this is not a curiosity — it is the difference between "no
    // visitors from Singapore" and "Singapore cannot be drawn here".
    //
    // 50m boundaries would include them at roughly five times the bytes, on a
    // panel that loads with every dashboard view. The chosen answer is to keep
    // 110m and name the gap in the UI.
    const ids = new Set(world.features.map(f => f.id))
    for (const code of ['SG', 'HK', 'MT', 'MC'])
      expect({ code, present: ids.has(code) }).toEqual({ code, present: false })

    expect(dashboard).toContain('data-country-missing')
    expect(dashboard).toContain('too small to plot at this scale')
  })

  test('no ring crosses the antimeridian outside the polar region', () => {
    // A ring holding both -180 and +179 is contiguous on a globe and a band
    // across the whole map on a flat one. Four rings did this — one of them
    // Russia's 467-point mainland, which painted a stripe through every country
    // at its latitude. Antarctica genuinely encircles the pole and is trimmed
    // from the view, so it is the one permitted exception.
    const rings = (g: any): any[] => (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat())
    const offenders: string[] = []
    for (const f of world.features) {
      for (const ring of rings(f.geometry)) {
        const lons = ring.map((p: number[]) => p[0])
        const lats = ring.map((p: number[]) => p[1])
        if (Math.max(...lons) - Math.min(...lons) > 180 && Math.max(...lats) > -58)
          offenders.push(f.id)
      }
    }
    expect(offenders).toEqual([])
  })

  test('stays small enough to ship on every dashboard load', () => {
    expect(readFileSync(geojson, 'utf8').length).toBeLessThan(250_000)
  })
})

describe('the panel obeys the stx rules this file has been bitten by', () => {
  /**
   * The panel markup, from its heading to the breakdown grid that follows —
   * with stx comments stripped.
   *
   * Stripping matters: the panel carries a comment explaining why it uses a
   * `<div>` and not a `<main>`, and matching raw source would fail on a correct
   * panel because the word appears in the prose justifying its own absence.
   * These assertions have to read markup, not commentary.
   */
  function panel(): string {
    const i = dashboard.indexOf('<div class="mt-6 p-5 panel reveal">')
    expect(i, 'the map panel is gone').toBeGreaterThan(-1)
    return dashboard.slice(i, dashboard.indexOf('Top countries', i)).replace(/\{\{--[\s\S]*?--\}\}/g, '')
  }

  test('nothing in the panel is a reactive mustache', () => {
    // stx cloaks any element whose own text is a reactive mustache, and x-cloak
    // is display:none — this has blanked the install panel, the team list and
    // the invite button. The map draws into an empty div precisely so that
    // nothing here is reactive.
    expect(panel()).not.toMatch(/\{\{\s*\w+\(\)/)
  })

  test('the panel does not introduce a second <main>', () => {
    // Fragment extraction slices from the first <main> to the LAST </main>, so a
    // second one makes the SPA swap the wrong span.
    expect(panel()).not.toContain('<main')
  })

  test('the server-rendered country list survives alongside the map', () => {
    // The map is blank until 340KB of engine and 170KB of geometry arrive, and
    // stays blank with JS off. The bar list is what a reader gets in the
    // meantime, and it is the only thing here carrying exact numbers.
    expect(dashboard).toContain('<BreakdownPanel title="Top countries"')
  })

  test('the empty state is server-rendered, not left to the map', () => {
    // A site with no country data must say so, not show an empty grey world.
    expect(panel()).toContain('No country data yet.')
  })
})

describe('the map talks to nothing but this origin', () => {
  test('the init script requests only same-origin paths', () => {
    // Verified in a real browser too: rendering produced 4 requests, all
    // same-origin, 0 off-origin. This pins the source so a later edit cannot
    // quietly add a tile layer or a geocoder.
    const s = mapScript()
    const urls = [...s.matchAll(/(?:import|fetch)\(\s*['"]([^'"]+)['"]/g)].map(m => m[1])
    expect(urls.length).toBeGreaterThan(1)
    for (const u of urls)
      expect({ u, sameOrigin: u.startsWith('/') }).toEqual({ u, sameOrigin: true })
  })

  test('no tile layer is ever constructed', () => {
    // A tile layer is the one thing that would turn this into a per-visitor
    // stream of requests to a third-party map host.
    const s = mapScript()
    expect(s).not.toMatch(/tileLayer|TileLayer|\{s\}|\{z\}\/\{x\}\/\{y\}/)
  })

  test('no geocoding or routing service is constructed', () => {
    expect(mapScript()).not.toMatch(/services|Nominatim|Photon|geocod/i)
  })

  test('interaction is disabled — this is a report, not an explorer', () => {
    const s = mapScript()
    for (const opt of ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'touchZoom'])
      expect({ opt, disabled: new RegExp(`${opt}:\\s*false`).test(s) }).toEqual({ opt, disabled: true })
  })

  test('colors are read from the theme tokens, not hardcoded', () => {
    // ts-maps has no CSS-variable support (zero custom properties in its CSS),
    // so unlike the hand-rolled traffic chart these must be resolved from the
    // root and re-applied when [data-theme] flips.
    const s = mapScript()
    expect(s).toContain('getPropertyValue(\'--accent\')')
    expect(s).toContain('MutationObserver')
    expect(s).toContain('data-theme')
  })

  test('clicking a country reuses the same filter contract as the list', () => {
    // A country on the map and its row in the list must not disagree about what
    // clicking does.
    const s = mapScript()
    expect(s).toContain('data-filter-base')
    expect(s).toMatch(/q\.set\('country',\s*code\)/)
    expect(s).toContain('window.stx.navigate')
  })
})
