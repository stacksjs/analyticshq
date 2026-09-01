import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * Define your scheduled tasks here. Jobs, actions, and shell commands
 * can all be scheduled with a fluent, expressive API.
 *
 * @see https://docs.stacksjs.com/scheduling
 */
export default function () {
  // Data retention: prune analytics rows older than ANALYTICSHQ_RETENTION_DAYS (a no-op
  // when that env var is unset or 0). Keeps the store to the configured window.
  // See scripts/analytics/prune.ts and issue #4.
  schedule
    .command('bun scripts/analytics/prune.ts')
    .daily()

  // Per-site email digests (#14). Daily on purpose: the job decides who is due —
  // weekly on Monday, monthly on the 1st, both UTC — rather than this file
  // carrying one schedule per cadence. That keeps "who gets mail today" in one
  // readable place, and makes a missed run cost a day instead of a month.
  // Sites opt in through `settings.digest`; absent means no mail.
  schedule
    .job('SendAnalyticsDigest')
    .daily()

  // Traffic spike/drop and threshold alerts (#24). Hourly, unlike the digest
  // above: a collapse discovered the next morning is a post-mortem, not an alert.
  // Hourly is also the coarsest cadence that matches the default one-hour
  // observation window, so consecutive runs neither overlap nor leave a gap.
  // Each alert carries its own window and cooldown, and the job skips anything
  // inside its quiet period before it queries anything.
  schedule
    .job('RunAnalyticsAlerts')
    .hourly()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
