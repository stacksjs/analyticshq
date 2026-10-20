import { describe, expect, test } from 'bun:test'
import { authorizeRead, LAST_USED_RESOLUTION_MS, looksLikeReadKey, newReadKey, sameKey, shouldRecordUse } from '../../app/Support/read-key'

const KEY = newReadKey()
const site = { id: 'demo', read_key: KEY }

describe('newReadKey', () => {
  test('is prefixed and carries 256 bits of hex', () => {
    expect(KEY.startsWith('ahq_read_')).toBe(true)
    expect(KEY.slice('ahq_read_'.length)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('does not repeat', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newReadKey()))
    expect(keys.size).toBe(200)
  })
})

describe('looksLikeReadKey', () => {
  test('accepts a key it minted', () => {
    expect(looksLikeReadKey(KEY)).toBe(true)
  })

  test('rejects anything else a bearer header might carry', () => {
    // The prefix is what keeps a read key out of Auth.getUserFromToken, so a
    // user's token and an ingest key must never pass for one.
    for (const value of [
      '',
      null,
      undefined,
      'some_other_credential_shape_entirely',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      `${'ahq_read_'}${'z'.repeat(64)}`,
      `${'ahq_read_'}${'a'.repeat(63)}`,
      `${'ahq_read_'}${'a'.repeat(65)}`,
      KEY.toUpperCase(),
    ])
      expect(looksLikeReadKey(value)).toBe(false)
  })
})

describe('sameKey', () => {
  test('matches an identical key and nothing else', () => {
    expect(sameKey(KEY, KEY)).toBe(true)
    expect(sameKey(KEY, newReadKey())).toBe(false)
  })

  test('is false on a shared prefix, not just a differing first byte', () => {
    const other = `${KEY.slice(0, -1)}${KEY.endsWith('a') ? 'b' : 'a'}`
    expect(sameKey(other, KEY)).toBe(false)
  })

  test('does not throw on a length mismatch', () => {
    expect(sameKey('short', KEY)).toBe(false)
    expect(sameKey(KEY, 'short')).toBe(false)
  })
})

describe('authorizeRead', () => {
  test('allows the site its own key', () => {
    expect(authorizeRead(site, KEY)).toEqual({ ok: true })
  })

  test('refuses an unknown site with 404', () => {
    expect(authorizeRead(null, KEY)).toEqual({ ok: false, status: 404, error: 'Site not found' })
    expect(authorizeRead(undefined, KEY)).toEqual({ ok: false, status: 404, error: 'Site not found' })
  })

  test('refuses a site with no key issued, whatever is presented', () => {
    // Guards `null === null`: no key configured must never authorise, not even
    // against a caller presenting nothing.
    for (const presented of [KEY, null, undefined, ''])
      expect(authorizeRead({ ...site, read_key: null }, presented).ok).toBe(false)
    // Narrowed rather than reached into: the refusal shape only carries a
    // status on the failing branch of the union.
    const refused = authorizeRead({ ...site, read_key: null }, KEY)
    expect(refused.ok).toBe(false)
    if (!refused.ok)
      expect(refused.status).toBe(403)
  })

  test('refuses another project\'s key with 401', () => {
    expect(authorizeRead(site, newReadKey())).toEqual({ ok: false, status: 401, error: 'Unauthorized' })
  })

  test('refuses a stored value that is not a well-formed key', () => {
    // A column hand-edited to something short must not become a weak key.
    expect(authorizeRead({ ...site, read_key: 'x' }, 'x').ok).toBe(false)
  })
})

describe('shouldRecordUse', () => {
  const now = new Date('2026-10-19T12:00:00.000Z')

  test('records the first use', () => {
    expect(shouldRecordUse(null, now)).toBe(true)
    expect(shouldRecordUse(undefined, now)).toBe(true)
  })

  test('records again once the resolution has passed, and not before', () => {
    const justBefore = new Date(now.getTime() - LAST_USED_RESOLUTION_MS + 1).toISOString()
    const atResolution = new Date(now.getTime() - LAST_USED_RESOLUTION_MS).toISOString()
    expect(shouldRecordUse(justBefore, now)).toBe(false)
    expect(shouldRecordUse(atResolution, now)).toBe(true)
  })

  test('records when the stored stamp cannot be read', () => {
    // Better an extra write than a key that never looks used.
    expect(shouldRecordUse('not a date', now)).toBe(true)
  })

  test('accepts a Date as well as a string', () => {
    expect(shouldRecordUse(new Date(now.getTime() - 1000), now)).toBe(false)
  })
})
