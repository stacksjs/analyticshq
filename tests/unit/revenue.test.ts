/**
 * Conversion revenue (#22).
 *
 * Money is the thing that gets quietly wrong rather than loudly broken: a total
 * that is 100x too high for one currency, or a few cents adrift from the
 * customer's books, looks like data rather than a bug. So the arithmetic is
 * tested exhaustively here, and the aggregation is verified against a real
 * Postgres separately — including that a bigint sum survives an amount an integer
 * column would have overflowed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  exponentFor,
  formatMinor,
  isCurrencyCode,
  MAX_MINOR_UNITS,
  normalizeCurrency,
  resolveConversionAmount,
  toMinorUnits,
} from '../../app/Analytics/money'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('the currency exponent', () => {
  test('is zero for currencies with no minor unit', () => {
    // The bug this prevents: ¥1000 stored as 100000 overstates a Japanese site's
    // revenue by 100x, consistently, so it reads as a great quarter.
    for (const code of ['JPY', 'KRW', 'ISK', 'VND', 'XOF', 'CLP'])
      expect(exponentFor(code), code).toBe(0)
  })

  test('is three for the currencies that have three', () => {
    for (const code of ['BHD', 'KWD', 'JOD', 'OMR', 'TND', 'IQD', 'LYD'])
      expect(exponentFor(code), code).toBe(3)
  })

  test('and two for everything else, including codes we do not know', () => {
    for (const code of ['USD', 'EUR', 'GBP', 'AUD', 'ZZZ'])
      expect(exponentFor(code), code).toBe(2)
  })

  test('is case-insensitive, because input is not normalised everywhere', () => {
    expect(exponentFor('jpy')).toBe(0)
    expect(exponentFor('kwd')).toBe(3)
  })
})

describe('currency codes', () => {
  test('are three uppercase letters and nothing else', () => {
    expect(isCurrencyCode('USD')).toBe(true)
    for (const bad of ['usd', 'US', 'USDD', 'U5D', '', '   ', 'US$', null, 3])
      expect(isCurrencyCode(bad), String(bad)).toBe(false)
  })

  test('normalising trims and uppercases, or gives up', () => {
    expect(normalizeCurrency(' usd ')).toBe('USD')
    expect(normalizeCurrency('eur')).toBe('EUR')
    for (const bad of ['dollars', '', null, undefined, 42, {}])
      expect(normalizeCurrency(bad), String(bad)).toBeNull()
  })
})

describe('converting an amount to minor units', () => {
  test('the ordinary cases', () => {
    expect(toMinorUnits('19.99', 'USD')).toBe(1999)
    expect(toMinorUnits('7.5', 'USD')).toBe(750)
    expect(toMinorUnits('7', 'USD')).toBe(700)
    expect(toMinorUnits('0.05', 'USD')).toBe(5)
    expect(toMinorUnits('0', 'USD')).toBe(0)
  })

  test('respects the currency exponent', () => {
    expect(toMinorUnits('1000', 'JPY')).toBe(1000)
    expect(toMinorUnits('1000.99', 'JPY')).toBe(1000) // no minor unit to keep
    expect(toMinorUnits('1.234', 'KWD')).toBe(1234)
    expect(toMinorUnits('1.2', 'KWD')).toBe(1200)
  })

  test('truncates extra precision rather than rounding it up', () => {
    // Rounding up would invent money. A price with more precision than its
    // currency has is a mistake at the source and should not grow on the way in.
    expect(toMinorUnits('1.009', 'USD')).toBe(100)
    expect(toMinorUnits('1.999', 'USD')).toBe(199)
  })

  test('accepts a float, having already lost exactness to it', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754. A caller who cares sends a
    // string; a number is normalised through toFixed, which is deterministic.
    expect(toMinorUnits(19.99, 'USD')).toBe(1999)
    expect(toMinorUnits(0.1 + 0.2, 'USD')).toBe(30)
    expect(toMinorUnits(1000, 'JPY')).toBe(1000)
  })

  test('handles refunds', () => {
    expect(toMinorUnits('-5.00', 'USD')).toBe(-500)
    expect(toMinorUnits(-5, 'USD')).toBe(-500)
  })

  test('refuses anything it cannot represent exactly', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '1,99', '1e10', '$5', '5 USD', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY])
      expect(toMinorUnits(bad, 'USD'), JSON.stringify(bad)).toBeNull()
  })

  test('refuses an absurd amount rather than clamping it', () => {
    // A clamped revenue figure is a wrong figure that looks right, so the caller
    // is made to decide instead.
    expect(toMinorUnits(String(MAX_MINOR_UNITS + 1), 'USD')).toBeNull()
    expect(toMinorUnits('99999999999999999', 'USD')).toBeNull()
  })
})

describe('formatting', () => {
  test('renders minor units back to a decimal string', () => {
    expect(formatMinor(1999, 'USD')).toBe('19.99')
    expect(formatMinor(5, 'USD')).toBe('0.05')
    expect(formatMinor(0, 'USD')).toBe('0.00')
    expect(formatMinor(-500, 'USD')).toBe('-5.00')
    expect(formatMinor(1000, 'JPY')).toBe('1000')
    expect(formatMinor(1234, 'KWD')).toBe('1.234')
  })

  test('round-trips', () => {
    for (const [amount, currency] of [['19.99', 'USD'], ['1000', 'JPY'], ['1.234', 'KWD'], ['0.05', 'USD'], ['-5.00', 'USD']] as const) {
      const minor = toMinorUnits(amount, currency)
      expect(minor, amount).not.toBeNull()
      expect(formatMinor(minor as number, currency)).toBe(amount)
    }
  })

  test('returns a string, not a number', () => {
    // Handing back 19.99 as a float reintroduces the representation problem the
    // integer storage exists to avoid.
    expect(typeof formatMinor(1999, 'USD')).toBe('string')
  })
})

describe('what a conversion is worth', () => {
  test('the event wins over the goal default', () => {
    expect(resolveConversionAmount({
      eventAmount: '25.00',
      eventCurrency: 'USD',
      goalDefaultMinor: 999,
      goalCurrency: 'USD',
    })).toEqual({ amountMinor: 2500, currency: 'USD' })
  })

  test('the goal default fills in when the event says nothing', () => {
    // A fixed-price product should not need the front end to repeat its price on
    // every purchase.
    expect(resolveConversionAmount({
      goalDefaultMinor: 999,
      goalCurrency: 'USD',
    })).toEqual({ amountMinor: 999, currency: 'USD' })
  })

  test('a goal default is already in minor units and is not converted again', () => {
    // Re-parsing it would shift it by the exponent a second time: 999 cents would
    // become 99900.
    expect(resolveConversionAmount({ goalDefaultMinor: 999, goalCurrency: 'USD' }).amountMinor).toBe(999)
    expect(resolveConversionAmount({ goalDefaultMinor: 1000, goalCurrency: 'JPY' }).amountMinor).toBe(1000)
  })

  test('currency falls back event -> goal -> site', () => {
    expect(resolveConversionAmount({ eventAmount: '5', eventCurrency: 'EUR', goalCurrency: 'USD', siteCurrency: 'GBP' }).currency).toBe('EUR')
    expect(resolveConversionAmount({ eventAmount: '5', goalCurrency: 'USD', siteCurrency: 'GBP' }).currency).toBe('USD')
    expect(resolveConversionAmount({ eventAmount: '5', siteCurrency: 'GBP' }).currency).toBe('GBP')
  })

  test('and the amount is read in whatever currency won', () => {
    // The exponent comes from the resolved currency, so a site defaulting to JPY
    // must not have its amounts divided by 100.
    expect(resolveConversionAmount({ eventAmount: '1000', siteCurrency: 'JPY' }))
      .toEqual({ amountMinor: 1000, currency: 'JPY' })
    expect(resolveConversionAmount({ eventAmount: '1000', siteCurrency: 'USD' }))
      .toEqual({ amountMinor: 100000, currency: 'USD' })
  })

  test('no currency anywhere means no revenue, not a guess', () => {
    // Defaulting to USD would silently label a European store's sales as dollars.
    expect(resolveConversionAmount({ eventAmount: '19.99' })).toEqual({ amountMinor: null, currency: null })
  })

  test('a currency with no amount stores neither', () => {
    // Otherwise the row groups into the revenue report contributing nothing,
    // which reads as "this currency earned zero" rather than "no sale here".
    expect(resolveConversionAmount({ eventCurrency: 'USD' })).toEqual({ amountMinor: null, currency: null })
    expect(resolveConversionAmount({ siteCurrency: 'USD' })).toEqual({ amountMinor: null, currency: null })
  })

  test('an unparseable event amount falls through to the goal default', () => {
    expect(resolveConversionAmount({
      eventAmount: 'not a number',
      goalDefaultMinor: 500,
      siteCurrency: 'USD',
    })).toEqual({ amountMinor: 500, currency: 'USD' })
  })

  test('and to nothing when there is no default either', () => {
    expect(resolveConversionAmount({ eventAmount: 'not a number', siteCurrency: 'USD' }))
      .toEqual({ amountMinor: null, currency: null })
  })
})

describe('the wiring a later edit could quietly loosen', () => {
  const routes = code('routes/analytics.ts')

  test('revenue is reported per currency and never summed across them', () => {
    // Adding dollars to euros needs an exchange rate, and picking one would
    // fabricate the figure — silently, at whatever rate applied that day, in a
    // number the customer would reconcile against their own books.
    const i = routes.indexOf(`route.get('/api/sites/{siteId}/revenue'`)
    expect(i, 'the revenue endpoint is missing').toBeGreaterThan(-1)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect(block).toContain('GROUP BY currency')
    // A bare SUM with no currency grouping is the shape of the bug.
    expect(block).not.toMatch(/SUM\(amount_minor\)\s+AS\s+\w+\s+FROM conversions\s+WHERE[^)]*?(?!GROUP BY)/s)
  })

  test('rows with an amount but no currency are excluded, not bucketed', () => {
    // Shown under a blank heading they would be read as the site's default.
    const i = routes.indexOf(`route.get('/api/sites/{siteId}/revenue'`)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect((block.match(/currency IS NOT NULL/g) ?? []).length).toBe(2)
  })

  test('the beacon resolves revenue through the tested precedence', () => {
    expect(routes).toContain('resolveConversionAmount({')
  })

  test('the legacy value column is still written and not reinterpreted', () => {
    // goals.value holds whatever number its creator typed, with no record of
    // whether it meant dollars or cents. Reusing it would silently reinterpret
    // every row written before revenue existed.
    expect(routes).toContain('value: goal.value ?? null')
  })
})
