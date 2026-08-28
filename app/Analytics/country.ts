/**
 * One definition of "what goes in the country column".
 *
 * `page_views.country` and `sessions.country` are `varchar(2)` — ISO 3166-1
 * alpha-2, uppercase (migrations `0000000003` / `0000000005`). Several inputs
 * arrive as something else:
 *
 *   - GA4's export gives the full English name ("United States").
 *   - `getCountryFromHeaders` in `@ts-analytics/tracking` also returns a NAME
 *     for the ~50 codes it knows, and only falls through to the bare code for
 *     ones it does not — so the CDN-header path produces a name too.
 *   - A geo-IP lookup gives a clean ISO code and needs nothing done to it.
 *
 * Writing a name into a `varchar(2)` either errors (Postgres `22001`) or
 * truncates, and a truncated country is worse than a missing one: "Ne" is not
 * the Netherlands, it is a country that does not exist, silently polluting
 * every report that groups by this column.
 *
 * This lived in `ga-import.ts` and was correct there, but only there — the
 * importer normalized while the live ingest path did not, so the column's
 * invariant held for backfilled rows and not for real traffic. It is shared
 * now because both callers need it and there must not be two answers.
 */

/**
 * Full English name → ISO 3166-1 alpha-2.
 *
 * Deliberately not exhaustive. An unmapped name returns `null` ("no country
 * recorded") rather than a guess, which is the honest failure — see
 * {@link normCountry}.
 */
const COUNTRY_MAP: Record<string, string> = {
  'United States': 'US',
  'United Kingdom': 'GB',
  'Germany': 'DE',
  'France': 'FR',
  'Canada': 'CA',
  'Australia': 'AU',
  'India': 'IN',
  'Japan': 'JP',
  'Brazil': 'BR',
  'Netherlands': 'NL',
  'Spain': 'ES',
  'Italy': 'IT',
  'Sweden': 'SE',
  'Switzerland': 'CH',
  'Ireland': 'IE',
  'Poland': 'PL',
  'Mexico': 'MX',
  'South Korea': 'KR',
  'China': 'CN',
  'Russia': 'RU',
  'Norway': 'NO',
  'Denmark': 'DK',
  'Finland': 'FI',
  'Belgium': 'BE',
  'Austria': 'AT',
  'Portugal': 'PT',
  'Greece': 'GR',
  'Turkey': 'TR',
  'Israel': 'IL',
  'South Africa': 'ZA',
  'Singapore': 'SG',
  'Hong Kong': 'HK',
  'Taiwan': 'TW',
  'Indonesia': 'ID',
  'Thailand': 'TH',
  'Malaysia': 'MY',
  'Philippines': 'PH',
  'Vietnam': 'VN',
  'New Zealand': 'NZ',
  'Argentina': 'AR',
  'Chile': 'CL',
  'Colombia': 'CO',
  'Ukraine': 'UA',
  'Czech Republic': 'CZ',
  'Czechia': 'CZ',
  'Romania': 'RO',
  'Hungary': 'HU',
  'United Arab Emirates': 'AE',
  'Saudi Arabia': 'SA',
  'Egypt': 'EG',
  'Nigeria': 'NG',
  'Pakistan': 'PK',
  'Bangladesh': 'BD',
}

/**
 * Coerce a country value to what the column can hold.
 *
 * A 2-letter input is taken as already-an-ISO-code and upper-cased; anything
 * else is looked up by name; an unmapped name is `null`.
 */
export function normCountry(v: string): string | null {
  const s = (v || '').trim()
  if (/^[A-Za-z]{2}$/.test(s))
    return s.toUpperCase()
  return COUNTRY_MAP[s] || null
}
