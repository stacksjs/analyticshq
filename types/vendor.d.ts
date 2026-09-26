/**
 * Browser modules this app serves from public/vendor/ rather than bundles, as
 * AMBIENT declarations (rule 10b).
 *
 * dashboard.stx loads the map engine with `import('/vendor/ts-maps.js')`. That file
 * is `node_modules/ts-maps/dist/index.js` built for the browser by
 * `bun run vendor:map`, and tests/unit/country-map.test.ts fails the moment the two
 * drift, so its exports are exactly the installed package's.
 */
type TsMapsModule = typeof import('ts-maps')

/** One country in public/vendor/world-countries.geojson (Natural Earth, 110m). */
interface WorldFeature {
  /** ISO 3166-1 alpha-2, the same code page_views.country holds. */
  id: string
  properties?: { name?: string } | null
  geometry?: { type: 'Polygon', coordinates: Array<Array<[number, number]>> } | { type: 'MultiPolygon', coordinates: Array<Array<Array<[number, number]>>> } | null
}

interface WorldGeometry {
  type: 'FeatureCollection'
  features: WorldFeature[]
}
