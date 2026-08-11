/**
 * Scheduled email digests (#14).
 *
 * The parts worth testing are the ones that decide whether a stranger gets mail:
 * who is due today, what counts as opted in, and what a delta means when there is
 * nothing to compare against. The send itself needs a mailer and a database, so it
 * is covered by shape rather than by dispatch.
 *
 * The bias throughout is toward NOT sending. Every address here belongs to a
 * customer who never asked for mail, so every ambiguous case — malformed
 * settings, an unknown cadence, a period with no traffic — has to resolve to
 * silence rather than to a message.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { delta } from '../../app/Analytics/summary'
import { cadenceOf, cadencesDueOn, windowFor } from '../../app/Jobs/SendAnalyticsDigest'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('who is due today', () => {
  // 2026-08-03 is a Monday; 2026-09-01 is a Tuesday and the 1st.
  test('weekly goes out on Mondays', () => {
    expect(cadencesDueOn(new Date('2026-08-03T06:00:00Z'))).toContain('weekly')
    expect(cadencesDueOn(new Date('2026-08-04T06:00:00Z'))).not.toContain('weekly')
  })

  test('monthly goes out on the 1st', () => {
    expect(cadencesDueOn(new Date('2026-09-01T06:00:00Z'))).toContain('monthly')
    expect(cadencesDueOn(new Date('2026-09-02T06:00:00Z'))).not.toContain('monthly')
  })

  test('a Monday the 1st sends both, not one or neither', () => {
    // 2026-06-01 is a Monday. The job runs daily and filters, so this is the case
    // where a per-cadence cron schedule would have been easy to get wrong.
    const due = cadencesDueOn(new Date('2026-06-01T06:00:00Z'))
    expect(due).toEqual(expect.arrayContaining(['weekly', 'monthly']))
    expect(due.length).toBe(2)
  })

  test('most days nobody is due', () => {
    expect(cadencesDueOn(new Date('2026-08-05T06:00:00Z'))).toEqual([])
  })

  test('the boundary is UTC, not local time', () => {
    // 2026-08-02 23:00Z is a Sunday in UTC and a Monday in, say, Sydney. The job
    // must agree with itself wherever it runs.
    expect(cadencesDueOn(new Date('2026-08-02T23:00:00Z'))).toEqual([])
    expect(cadencesDueOn(new Date('2026-08-03T00:30:00Z'))).toContain('weekly')
  })
})

describe('what counts as opted in', () => {
  test('an explicit cadence opts in', () => {
    expect(cadenceOf('{"digest":"weekly"}')).toBe('weekly')
    expect(cadenceOf('{"digest":"monthly"}')).toBe('monthly')
  })

  test('absent means off', () => {
    // This is the default for every site that has never touched the setting.
    expect(cadenceOf('{}')).toBeNull()
    expect(cadenceOf('{"share_token":"abc"}')).toBeNull()
    expect(cadenceOf(null)).toBeNull()
    expect(cadenceOf('')).toBeNull()
  })

  test('an unrecognised value is off, not a default cadence', () => {
    // 'daily', 'true' and 'yes' are all things someone might POST. None of them
    // may be read as consent to a cadence nobody chose.
    for (const v of ['daily', 'true', 'yes', '1', 'WEEKLY '])
      expect(cadenceOf(`{"digest":${JSON.stringify(v)}}`)).toBeNull()
  })

  test('malformed settings JSON is off, not a crash and not a send', () => {
    expect(cadenceOf('{not json')).toBeNull()
  })
})

describe('the reporting window', () => {
  test('weekly looks back seven days, monthly thirty', () => {
    const now = new Date('2026-08-03T06:00:00Z')
    const w = windowFor('weekly', now)
    const m = windowFor('monthly', now)
    expect((w.to.getTime() - w.from.getTime()) / 86400000).toBe(7)
    expect((m.to.getTime() - m.from.getTime()) / 86400000).toBe(30)
    expect(w.to).toEqual(now)
  })
})

describe('deltas', () => {
  test('a percentage change when there is a baseline', () => {
    expect(delta(110, 100)).toBe(10)
    expect(delta(90, 100)).toBe(-10)
    expect(delta(100, 100)).toBe(0)
  })

  test('no baseline is null, not zero and not Infinity', () => {
    // "first week, nothing to compare" and "flat against last week" are different
    // facts. Rendering them the same would tell the reader something untrue.
    expect(delta(50, 0)).toBeNull()
    expect(delta(0, 0)).toBeNull()
  })
})

describe('the wiring holds', () => {
  test('the KPI query matches the one the dashboard API answers with', () => {
    // If these drift, the email contradicts the dashboard — worse than either
    // being wrong on its own.
    const summary = read('app/Analytics/summary.ts')
    const routes = read('routes/analytics.ts')
    for (const fragment of ['COUNT(*) AS views', 'COUNT(DISTINCT visitor_id) AS visitors', 'COUNT(DISTINCT session_id) AS sessions']) {
      expect(summary).toContain(fragment)
      expect(routes).toContain(fragment)
    }
  })

  test('the job is scheduled, and daily rather than per-cadence', () => {
    const scheduler = read('app/Scheduler.ts')
    expect(scheduler).toContain(`job('SendAnalyticsDigest')`)
    const block = scheduler.slice(scheduler.indexOf('SendAnalyticsDigest'))
    expect(block).toMatch(/\.daily\(\)/)
  })

  test('the opt-in endpoint rejects anything but the three known values', () => {
    const routes = read('routes/analytics.ts')
    expect(routes).toContain(`['weekly', 'monthly', 'off'].includes(value)`)
    // 'off' must delete the key: absent is what the job reads as off, so storing
    // a falsy value instead would create a second spelling of the same state.
    expect(routes).toMatch(/delete settings\.digest/)
  })

  test('a refused delivery is not counted as sent', () => {
    // mail.send resolves with `success: false` rather than throwing, so counting
    // the call instead of its result reported "sent 1" against a dead SMTP host —
    // measured, before this was fixed. The sender returns a boolean and the job
    // has to branch on it.
    const mailer = read('app/Mail/AnalyticsDigest.ts')
    expect(mailer).toMatch(/Promise<boolean>/)
    expect(mailer).toMatch(/result\?\.success !== false/)

    const job = read('app/Jobs/SendAnalyticsDigest.ts')
    expect(job).toMatch(/const ok = await sendAnalyticsDigest/)
    expect(job).toMatch(/if \(ok\)\s*\n\s*sent\+\+/)
    expect(job).toContain('failed++')
  })

  test('the template is a complete document, which is correct only for email', () => {
    // stx-standards §3.1 forbids a DOCTYPE in pages and components because it
    // suppresses the generated shell. An email is neither, and every client
    // expects a full document — so this is the one place it belongs.
    const tpl = read('resources/emails/analytics-digest.stx')
    expect(tpl).toContain('<!DOCTYPE html>')
    expect(tpl).not.toContain('@extends(')
  })
})
