/**
 * Data-retention window helpers (issue #4).
 */
import { describe, expect, test } from 'bun:test'
import { retentionCutoff, retentionDays } from '../../scripts/analytics/lib'

describe('retentionDays', () => {
  test('a positive integer enables retention', () => {
    expect(retentionDays({ ANALYTICSHQ_RETENTION_DAYS: '395' })).toBe(395)
  })
  test('floors fractional values', () => {
    expect(retentionDays({ ANALYTICSHQ_RETENTION_DAYS: '30.7' })).toBe(30)
  })
  test('unset / 0 / negative / non-numeric = disabled (0)', () => {
    expect(retentionDays({})).toBe(0)
    expect(retentionDays({ ANALYTICSHQ_RETENTION_DAYS: '0' })).toBe(0)
    expect(retentionDays({ ANALYTICSHQ_RETENTION_DAYS: '-5' })).toBe(0)
    expect(retentionDays({ ANALYTICSHQ_RETENTION_DAYS: 'forever' })).toBe(0)
  })
})

describe('retentionCutoff', () => {
  const now = new Date('2026-07-21T12:00:00.000Z')

  test('disabled (days <= 0) → null, so nothing is ever pruned', () => {
    expect(retentionCutoff(0, now)).toBeNull()
    expect(retentionCutoff(-1, now)).toBeNull()
  })

  test('returns an ISO cutoff exactly N days before now', () => {
    expect(retentionCutoff(30, now)).toBe('2026-06-21T12:00:00.000Z')
    expect(retentionCutoff(1, now)).toBe('2026-07-20T12:00:00.000Z')
  })

  test('the cutoff is lexically comparable to stored ISO timestamps', () => {
    const cutoff = retentionCutoff(7, now)!
    // an older row sorts before the cutoff (pruned); a newer one does not.
    expect('2026-07-01T00:00:00.000Z' < cutoff).toBe(true)
    expect('2026-07-20T00:00:00.000Z' < cutoff).toBe(false)
  })
})
