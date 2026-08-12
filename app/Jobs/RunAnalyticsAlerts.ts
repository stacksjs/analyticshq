import type { AlertRow } from '../Analytics/alerts'
import { log } from '@stacksjs/cli'
import { db } from '@stacksjs/database'
import { Job } from '@stacksjs/queue'
import { evaluate, inCooldown, isRelative, observationWindow, observe } from '../Analytics/alerts'
import { deliver } from '../Alerts/delivery'

/**
 * Check every live alert and notify whoever asked (#24).
 *
 * ## Hourly, not daily
 *
 * The digest job runs daily because a weekly summary is not urgent. An alert is
 * the opposite: a traffic collapse found the next morning is a post-mortem, not
 * an alert. Hourly is the coarsest cadence at which the word still applies, and
 * it matches the one-hour default observation window so consecutive runs neither
 * overlap nor leave a gap.
 *
 * Each alert still carries its own `window_minutes`, so a site that wants a
 * 6-hour view gets one — it is simply re-evaluated every hour rather than every
 * six.
 *
 * ## Cooldown is checked before the query, not after
 *
 * An alert inside its quiet period cannot produce a notification no matter what
 * the numbers say, so computing them would be work done to be thrown away. On a
 * busy install this is most of the alerts most of the time: the check is a field
 * comparison, the work it skips is a metric query plus a week of baseline
 * samples.
 *
 * ## Failure is per-alert
 *
 * One site's broken webhook, one deleted goal, one malformed channel list must
 * not stop every later alert in the run. Errors are logged with the alert id and
 * counted, and the loop continues — the same reasoning as the digest job, and for
 * the same reason: the failures that matter here are the ones nobody hears about.
 */

interface AlertWithSite extends AlertRow {
  site_name: string | null
}

export interface AlertRunResult {
  checked: number
  fired: number
  suppressed: number
  delivered: number
  failed: number
}

/**
 * Alerts eligible for evaluation, with the site name the notification needs.
 *
 * The inner join drops alerts whose site is gone. The FK cascades, so this should
 * be empty — it is an inner join rather than a left one because an alert with no
 * site has nothing to report on and nobody to name.
 */
export async function liveAlerts(): Promise<AlertWithSite[]> {
  return await db.unsafe(
    `SELECT a.*, s.name AS site_name
     FROM site_alerts a JOIN sites s ON s.id = a.site_id
     WHERE a.is_active = true`,
  ).catch(() => []) as AlertWithSite[]
}

/** Stamp the quiet period. Written before delivery is attempted — see below. */
async function markFired(id: string, now: Date): Promise<void> {
  await db.unsafe(
    `UPDATE site_alerts SET last_fired_at = $1, updated_at = $1 WHERE id = $2`,
    [now.toISOString(), id],
  ).catch((error: unknown) => {
    // A failure here means the cooldown was not recorded, so the next run fires
    // the same alert again. Loud, because duplicate notifications are how people
    // learn to ignore a channel.
    log.error(`[alerts] could not stamp cooldown for ${id}`, error)
  })
}

export async function runAnalyticsAlerts(now: Date = new Date()): Promise<AlertRunResult> {
  const alerts = await liveAlerts()

  const result: AlertRunResult = { checked: 0, fired: 0, suppressed: 0, delivered: 0, failed: 0 }

  for (const alert of alerts ?? []) {
    try {
      if (inCooldown(alert, now)) {
        result.suppressed++
        continue
      }

      result.checked++

      const { observed, baseline } = await observe(alert, now)
      const evaluation = evaluate(alert, observed, baseline)

      if (!evaluation.fires)
        continue

      result.fired++

      // Stamped before delivery, not after. If delivery is slow and the next
      // hourly run starts, an unstamped alert would be evaluated again and fire
      // a second time for the same event. Recording the decision rather than the
      // outcome means a failed send costs one missed notification, where the
      // other order costs a duplicate — and a duplicate is the failure that
      // trains people to mute the channel.
      await markFired(alert.id, now)

      const { delivered, failed } = await deliver({
        alert,
        siteId: alert.site_id,
        siteName: alert.site_name || alert.site_id,
        evaluation,
        window: observationWindow(Number(alert.window_minutes), now),
      })

      result.delivered += delivered
      result.failed += failed

      log.info(
        `[alerts] ${alert.name} fired for ${alert.site_id}: ${evaluation.reason}`
        + `${isRelative(alert.condition as never) ? '' : ' (absolute)'}`,
      )
    }
    catch (error) {
      log.error(`[alerts] failed for alert ${alert.id}`, error)
      result.failed++
    }
  }

  return result
}

export default new Job({
  handle: async () => {
    const { checked, fired, suppressed, delivered, failed } = await runAnalyticsAlerts()
    log.info(`[alerts] checked ${checked}, fired ${fired}, suppressed ${suppressed}, delivered ${delivered}, failed ${failed}`)
  },
})
