/**
 * How a visitor reads on screen, for the dashboard's Visitors panel and the
 * /visitor page. Pure, so both render the same words and tests can pin them.
 *
 * A visitor has no name, and must not look like it has one. The label is the
 * start of its hash, the way a commit is named by the start of its sha.
 */

import { cityLabel, splitCity } from '../Analytics/cities'
import { countryName, flag } from './dashboard-format'
import { zonedKey, zoneLabel } from './timezone'

/** `#3f9a2c`: the first six characters of the visitor hash. */
export function visitorLabel(visitorId: string | null | undefined): string {
  return `#${String(visitorId ?? '').slice(0, 6) || '------'}`
}

/** `🇺🇸 Santa Monica, CA`, or `🇺🇸 United States` when no city was recorded. */
export function placeLabel(country: string | null | undefined, city?: string | null): string {
  const parts = splitCity(city)
  if (parts)
    return `${flag(parts.country)} ${cityLabel(city)}`
  if (!country)
    return 'Unknown location'
  return `${flag(country)} ${countryName(country)}`
}

/** `3h ago`, `2d ago`, `just now`. Relative to `now`, which tests pass in. */
export function timeAgo(at: string | null | undefined, now: Date = new Date()): string {
  const t = at ? new Date(at).getTime() : Number.NaN
  if (!Number.isFinite(t))
    return ''
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000))
  if (secs < 60)
    return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60)
    return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24)
    return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** `Sep 25, 14:05 PDT`: the wall clock in `tz`, which is the reader's zone when known. */
export function stamp(at: string | null | undefined, tz: string = 'UTC'): string {
  const d = at ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime()))
    return ''
  const key = zonedKey(d, tz)
  const month = new Date(`${key.slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${month} ${Number(key.slice(8, 10))}, ${key.slice(11, 16)} ${zoneLabel(tz, d)}`
}

/** `12 visits`, `1 visit`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** `$12.00` from minor units, or `12.00 EUR` when the currency has no symbol here. */
export function money(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor == null)
    return ''
  const code = String(currency || 'USD').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(minor / 100)
  }
  catch {
    return `${(minor / 100).toFixed(2)} ${code}`
  }
}
