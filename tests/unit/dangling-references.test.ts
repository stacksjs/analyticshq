/**
 * Every name this app schedules or registers must resolve to a file that exists.
 *
 * `app/Scheduler.ts`, `app/Commands.ts` and `app/Events.ts` all refer to code by
 * string. Nothing typechecks those strings — the framework ships a
 * `SchedulableJobs` augmentation intended to, but the generator that would write
 * `storage/framework/types/scheduled.d.ts` never runs, so `SchedulableJobName`
 * collapses to `string` and `schedule.job('Inpsire')` compiles.
 *
 * ## Why this test exists
 *
 * Commit `ee41406` ("chore(ui): remove desktop-demo scaffold") deleted
 * `app/Jobs/Inspire.ts`, `app/Commands/Inspire.ts`, `app/Actions/SendWelcomeEmail.ts`
 * and `app/Actions/NotifyUser.ts`. Its message says "nothing referenced these."
 * Four things did. The scheduler kept calling `.job('Inspire')` hourly, and every
 * hour from then until this test was written it logged two errors into
 * production — 37 of the 115 entries in the log stream, a third of the volume and
 * all of the error count, from one job that printed a quote.
 *
 * It was invisible for two months. Nothing fails, nothing pages, the tick
 * swallows the rejection and reschedules; the only symptom is a line in a log
 * nobody was reading. It surfaced the week the app started shipping logs to
 * loghq, which is the argument for that integration made better by accident than
 * on purpose.
 *
 * The existing scheduler tests assert that a given job name *appears* in
 * `app/Scheduler.ts`. That is the assertion that lets this through: it checks the
 * caller, never the callee. This checks that every callee exists.
 *
 * ## Not yet covered: app/Events.ts
 *
 * The same commit orphaned two event listeners, and they are still orphaned —
 * `user:registered` is emitted on every registration by the framework's
 * `RegisterAction`, and `[events] user:registered: no listener or action called
 * SendWelcomeEmail` is logged at every boot. Whether that is fixed by restoring
 * the action or by deleting the mapping is a product decision about whether this
 * app sends welcome mail, not a cleanup. When it is settled, add the third
 * surface here: read `app/Events.ts`, and assert each listener resolves under
 * `app/Actions/` or `app/Listeners/`.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

describe('app/Scheduler.ts', () => {
  const source = read('app/Scheduler.ts')

  test('every scheduled job has a file in app/Jobs', () => {
    const names = [...source.matchAll(/\.job\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]!)

    // A guard that asserts nothing when the regex stops matching is worse than
    // no guard, because it keeps passing. This app schedules at least two jobs.
    expect(names.length).toBeGreaterThanOrEqual(2)

    const missing = names.filter(name => !existsSync(join(root, 'app', 'Jobs', `${name}.ts`)))
    expect(missing).toEqual([])
  })

  test('every scheduled shell command points at a file that exists', () => {
    const commands = [...source.matchAll(/\.command\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]!)

    // Only the `bun <path>` form can be checked from here; anything else is a
    // binary on PATH and not this test's business.
    const scripts = commands
      .map(cmd => /^bun\s+(\S+\.ts)$/.exec(cmd)?.[1])
      .filter((p): p is string => typeof p === 'string')

    const missing = scripts.filter(rel => !existsSync(join(root, rel)))
    expect(missing).toEqual([])
  })
})

describe('app/Commands.ts', () => {
  test('every registered command has a file in app/Commands', () => {
    const source = read('app/Commands.ts')

    // The registry's own docblock carries `'inspire': 'Inspire'` as an @example.
    // Match only the default export's body so a documentation sample is not read
    // as a registration.
    const body = /export default (\{[\s\S]*?\}) satisfies CommandRegistry/.exec(source)?.[1] ?? ''
    const files = [
      ...[...body.matchAll(/['"]?[\w-]+['"]?\s*:\s*['"]([^'"]+)['"]/g)].map(m => m[1]!),
      ...[...body.matchAll(/file\s*:\s*['"]([^'"]+)['"]/g)].map(m => m[1]!),
    ]

    const missing = files.filter(name => !existsSync(join(root, 'app', 'Commands', `${name}.ts`)))
    expect(missing).toEqual([])
  })
})
