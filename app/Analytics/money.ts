/**
 * Money, for conversion revenue (#22).
 *
 * ## Minor units, always
 *
 * Revenue is stored as a whole number of the currency's smallest unit — cents for
 * USD, yen for JPY — and never as a decimal. Floating point cannot represent 0.10
 * exactly, so summing a column of prices in a float drifts, and the drift shows up
 * as a revenue total that disagrees with the customer's own books by a few cents
 * and cannot be explained. An integer count of cents has no such failure mode.
 *
 * ## The exponent is not always 2
 *
 * This is the part that is quietly wrong in most implementations. JPY, KRW and
 * ISK have NO minor unit: ¥1000 is 1000 minor units, not 100000. Getting that
 * wrong overstates revenue for a Japanese site by 100x, and it overstates it
 * consistently, so it looks like a great quarter rather than a bug. BHD, KWD, JOD
 * and OMR go the other way with three decimals.
 *
 * The table below covers the zero- and three-decimal currencies explicitly and
 * defaults everything else to 2, which is correct for every remaining
 * ISO 4217 code in ordinary use.
 *
 * ## Parsing without going through a float
 *
 * A string amount is shifted by moving the decimal point in the STRING, not by
 * multiplying. `19.99 * 100` is 1998.9999999999998 in IEEE 754, and while
 * rounding rescues that particular case, the general habit of multiplying money
 * by a power of ten is how rounding errors get in. Numbers arriving from JSON
 * have already been through a float and are normalised with `toFixed` first,
 * which is the most that can be recovered at that point — a caller who cares
 * about exactness sends a string.
 */

/** Currencies whose minor unit is not 1/100. Everything else defaults to 2. */
const EXPONENTS: Record<string, number> = {
  // No minor unit at all.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three decimal places.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
}

/** Beyond this an amount is abuse or a unit mix-up, not a sale. */
export const MAX_MINOR_UNITS = 1_000_000_000_000_000

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value)
}

/** Normalise user input to an ISO 4217 code, or null if it is not one. */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const code = value.trim().toUpperCase()
  return isCurrencyCode(code) ? code : null
}

/** How many decimal places this currency has. */
export function exponentFor(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2
}

/**
 * Convert an amount to whole minor units.
 *
 * Accepts a string (parsed exactly) or a number (normalised through `toFixed`
 * first, because it has already lost exactness by being a float). Returns null
 * for anything unparseable, non-finite, or beyond `MAX_MINOR_UNITS` — a caller
 * must decide what to do about that rather than receive a silently clamped
 * number, because a clamped revenue figure is a wrong figure that looks right.
 *
 * Extra decimal places are truncated, not rounded: 1.005 USD is 100 cents. A
 * price with more precision than its currency has is a mistake at the source, and
 * rounding it up would invent money.
 */
export function toMinorUnits(amount: unknown, currency: string): number | null {
  const exponent = exponentFor(currency)

  let text: string
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount))
      return null
    // Already a float, so exactness is gone. toFixed at the currency's precision
    // is the most that can be recovered, and it is deterministic.
    text = amount.toFixed(exponent)
  }
  else if (typeof amount === 'string') {
    text = amount.trim()
  }
  else {
    return null
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(text))
    return null

  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [whole, fraction = ''] = unsigned.split('.')

  // Truncate or pad the fraction to exactly the currency's precision, by string
  // surgery rather than arithmetic.
  const scaled = fraction.slice(0, exponent).padEnd(exponent, '0')
  const combined = `${whole}${scaled}`.replace(/^0+(?=\d)/, '')

  const minor = Number(combined)
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR_UNITS)
    return null

  return negative ? -minor : minor
}

/**
 * Decide what a conversion is worth, and in what currency.
 *
 * The precedence is the whole rule, and it is here rather than inline in the
 * beacon handler so it can be exercised without a running server:
 *
 *   amount    the event's own value, else the goal's default, else nothing
 *   currency  the event's, else the goal's, else the site's default
 *
 * A fixed-price product should not need the front end to repeat its price on
 * every purchase, and a single-currency site should not need to repeat its
 * currency at all — but a store selling in several must be able to say so per
 * event, which is why the event wins.
 *
 * Currency is returned only alongside an amount. A currency with no amount would
 * write rows that group into a revenue report contributing nothing, which reads
 * as "this currency earned zero" rather than "there was no sale here".
 */
export function resolveConversionAmount(input: {
  eventAmount?: unknown
  eventCurrency?: unknown
  goalDefaultMinor?: number | string | null
  goalCurrency?: unknown
  siteCurrency?: unknown
}): { amountMinor: number | null, currency: string | null } {
  const currency = normalizeCurrency(input.eventCurrency)
    ?? normalizeCurrency(input.goalCurrency)
    ?? normalizeCurrency(input.siteCurrency)

  let amountMinor: number | null = null

  const raw = input.eventAmount
  if (raw != null && raw !== '' && currency)
    amountMinor = toMinorUnits(raw, currency)

  if (amountMinor == null && input.goalDefaultMinor != null) {
    const fallback = Number(input.goalDefaultMinor)
    // A goal default is already stored in minor units, so it is used as-is rather
    // than re-parsed — converting it again would shift it by the exponent twice.
    if (Number.isSafeInteger(fallback))
      amountMinor = fallback
  }

  return { amountMinor, currency: amountMinor == null ? null : currency }
}

/**
 * Render minor units as a decimal string.
 *
 * A string, not a number: handing back 19.99 as a float re-introduces exactly the
 * representation problem the integer storage exists to avoid, and every consumer
 * of this is either displaying it or formatting it anyway.
 */
export function formatMinor(minor: number, currency: string): string {
  const exponent = exponentFor(currency)
  const negative = minor < 0
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0')
  const whole = digits.slice(0, digits.length - exponent) || '0'
  const fraction = exponent ? `.${digits.slice(digits.length - exponent)}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}
