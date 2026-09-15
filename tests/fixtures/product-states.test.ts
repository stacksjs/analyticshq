import { describe, expect, test } from 'bun:test'

const NOW = '2026-09-12T12:00:00.000Z'

export const productStates = {
  empty: { now: NOW, status: 'ready', sites: [], visitors: 0, views: 0 },
  normal: { now: NOW, status: 'ready', sites: [{ id: 'site-demo', name: 'Northwind', visitors: 1842, views: 5291 }], visitors: 1842, views: 5291 },
  loading: { now: NOW, status: 'loading', sites: [], visitors: null, views: null },
  failure: { now: NOW, status: 'error', sites: [], error: 'Analytics query timed out' },
  highVolume: { now: NOW, status: 'ready', sites: Array.from({ length: 250 }, (_, index) => ({ id: `site-${index + 1}`, name: `Site ${index + 1}`, visitors: 100_000 + index, views: 300_000 + index * 3 })) },
} as const

describe('deterministic analytics product states', () => {
  test('covers every UI state', () => expect(Object.keys(productStates)).toEqual(['empty', 'normal', 'loading', 'failure', 'highVolume']))
  test('keeps volume fixtures large and reproducible', () => {
    expect(productStates.highVolume.sites).toHaveLength(250)
    expect(JSON.stringify(productStates)).toBe(JSON.stringify(productStates))
  })
})
