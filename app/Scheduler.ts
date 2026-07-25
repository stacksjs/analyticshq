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
  // Run the Inspire job every hour
  schedule
    .job('Inspire')
    .hourly()
    .setTimeZone('America/Los_Angeles')

  // Data retention: prune analytics rows older than ANALYTICSHQ_RETENTION_DAYS (a no-op
  // when that env var is unset or 0). Keeps the store to the configured window.
  // See scripts/analytics/prune.ts and issue #4.
  schedule
    .command('bun scripts/analytics/prune.ts')
    .daily()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
