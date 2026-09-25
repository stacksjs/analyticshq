/**
 * Showing times in the timezone of whoever is reading the dashboard.
 *
 * Every timestamp is stored in UTC. The chart used to bucket in the site's
 * timezone, which defaults to UTC, so a reader in Los Angeles saw a spike
 * labelled 21:00 at what was 2pm for them. The dashboard now asks the browser
 * for its IANA zone once (POST /api/prefs/timezone stores it in a `tz` cookie)
 * and renders in it from then on, falling back to the site's zone.
 *
 * Pure, so the server render and the tests use the same functions.
 */

/** Cookie holding the viewer's zone. A display preference, nothing more. */
export const TZ_COOKIE = 'tz'

/**
 * A plausible IANA name that this runtime can format in, or null. The shape
 * check comes first because the value is later interpolated into SQL
 * (`timezone('<tz>', …)`): only letters, digits, `_ + - /` ever get through.
 */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const tz = value.trim()
  if (!/^[A-Za-z][\w+\-/]{0,63}$/.test(tz))
    return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  }
  catch {
    return null
  }
}

/**
 * `YYYY-MM-DDTHH:MM:SS` for an instant, as the wall clock reads in `tz`. The
 * same shape Postgres gives for `to_char(timezone(tz, ts), 'YYYY-MM-DD"T"HH24:MI:SS')`,
 * so a key built here matches a bucket built there.
 */
export function zonedKey(date: Date, tz: string): string {
  if (tz === 'UTC')
    return date.toISOString().slice(0, 19)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date).map(p => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

/** `PDT`, `CEST`, `UTC`. What the chart header shows. */
export function zoneLabel(tz: string, at: Date = new Date()): string {
  if (tz === 'UTC')
    return 'UTC'
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at)
      .find(x => x.type === 'timeZoneName')
      ?.value || tz
  }
  catch {
    return tz
  }
}

/**
 * The `Set-Cookie` value for the viewer's zone. A year, the whole site, sent on
 * same-site navigations. Not HttpOnly: it is a display preference with nothing
 * to steal, and the value is validated on every read.
 */
export function tzCookie(tz: string, secure: boolean): string {
  return `${TZ_COOKIE}=${encodeURIComponent(tz)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`
}
