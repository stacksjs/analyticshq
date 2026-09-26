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

/**
 * `17:50:12.345`: the wall clock in `tz`, to the millisecond. Page views are
 * stored with millisecond timestamps, and a visitor clicking through three
 * pages inside one minute reads as three identical `17:50`s without them.
 * Every zone offset is whole minutes, so the milliseconds never change with it.
 */
export function clockMs(at: string | null | undefined, tz: string = 'UTC'): string {
  const d = at ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime()))
    return ''
  return `${zonedKey(d, tz).slice(11, 19)}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`
}

/** `Sep 25, 17:50:12 PDT`: a visit's start, to the second. */
export function stampSeconds(at: string | null | undefined, tz: string = 'UTC'): string {
  const d = at ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime()))
    return ''
  const key = zonedKey(d, tz)
  const month = new Date(`${key.slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${month} ${Number(key.slice(8, 10))}, ${key.slice(11, 19)} ${zoneLabel(tz, d)}`
}

/**
 * The gap between two steps: `+845ms`, `+12.3s`, `+3m 12s`, `+1h 04m`. Empty
 * for the first step of a visit, or when either time is missing.
 */
export function gap(from: string | null | undefined, to: string | null | undefined): string {
  const a = from ? new Date(from).getTime() : Number.NaN
  const b = to ? new Date(to).getTime() : Number.NaN
  if (!Number.isFinite(a) || !Number.isFinite(b))
    return ''
  const ms = Math.max(0, b - a)
  if (ms < 1000)
    return `+${ms}ms`
  if (ms < 60_000)
    return `+${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000)
    return `+${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
  return `+${Math.floor(ms / 3_600_000)}h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`
}
