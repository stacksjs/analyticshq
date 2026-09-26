// The three datasets scripts/geo/build-subdivisions.ts reads. They are
// installed with `bun add --no-save` for the one run that regenerates
// app/Analytics/subdivisions.json and are not dependencies, so their own
// declarations are usually absent. These describe the parts the script reads.

declare module 'iso-3166' {
  /** One ISO 3166-2 subdivision: `code` is `US-CA`, `parent` the country or a parent subdivision. */
  export const iso31662: ReadonlyArray<{ code: string, parent: string, name: string }>
}

declare module 'country-region-data' {
  /** `[countryName, countryCode, [regionName, regionShortCode][]]`. */
  export const allCountries: ReadonlyArray<[string, string, ReadonlyArray<[string, string]>]>
}
