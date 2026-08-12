import type { AlertRow, Evaluation } from '../Analytics/alerts'
import { config } from '@stacksjs/config'
import { mail, template } from '@stacksjs/email'

/**
 * The email an alert sends (#24).
 *
 * Everything the template renders is decided here — the headline, the direction,
 * the accent colour, what "no baseline" reads like — so the template holds no
 * logic and cannot invent a different answer than the one that fired.
 */

export interface AnalyticsAlertOptions {
  to: string
  siteId: string
  siteName: string
  alert: AlertRow
  evaluation: Evaluation
  window: { from: Date, to: Date }
}

const METRIC_LABELS: Record<string, string> = {
  views: 'Page views',
  visitors: 'Visitors',
  sessions: 'Sessions',
  conversions: 'Conversions',
}

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

/** "in the last hour" / "in the last 15 minutes" / "in the last 6 hours". */
export function windowLabel(minutes: number): string {
  if (minutes < 60)
    return `in the last ${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'in the last hour' : `in the last ${hours} hours`
}

/**
 * The one line that has to survive being read on a lock screen.
 *
 * Subject lines are truncated aggressively, so the metric and the direction come
 * first and the site name is left to the body — someone with one alert configured
 * already knows which site it is, and someone with twenty needs the number more
 * than the name.
 */
export function headlineFor(alert: Pick<AlertRow, 'metric' | 'condition' | 'threshold'>, evaluation: Evaluation): string {
  const label = metricLabel(alert.metric)
  const { condition } = alert as { condition: string }

  if (condition === 'above')
    return `${label} passed ${num(Number(alert.threshold))}`
  if (condition === 'below')
    return `${label} fell below ${num(Number(alert.threshold))}`

  // A spike with no history has no percentage to quote — saying "up null%" or
  // inventing "up ∞%" would both be worse than describing what happened.
  if (evaluation.changePct === null)
    return `${label} where there are usually none`

  const magnitude = Math.abs(evaluation.changePct)
  return condition === 'drop'
    ? `${label} are down ${magnitude}%`
    : `${label} are up ${magnitude}%`
}

export async function sendAnalyticsAlert(options: AnalyticsAlertOptions): Promise<boolean> {
  const { to, siteId, siteName, alert, evaluation, window } = options

  const appName = config.app?.name || 'analyticshq'
  const appUrl = config.app?.url || 'https://analyticshq.org'
  const headline = headlineFor(alert, evaluation)
  const isDrop = alert.condition === 'drop' || alert.condition === 'below'

  const subject = `${headline} — ${siteName}`

  const { html, text } = await template('analytics-alert', {
    variables: {
      appName,
      siteName,
      alertName: alert.name,
      headline,
      detail: evaluation.reason,
      metricLabel: metricLabel(alert.metric),
      observed: num(evaluation.observed),
      // Empty string rather than "0" when there is nothing to compare against:
      // the template hides the column entirely, which is honest, where a zero
      // would read as a measured value.
      baseline: evaluation.baseline === null ? '' : num(evaluation.baseline),
      changeLabel: evaluation.changePct === null ? '' : `${evaluation.changePct >= 0 ? '+' : ''}${evaluation.changePct}%`,
      windowLabel: windowLabel(Number(alert.window_minutes)),
      accent: isDrop ? '#f0806c' : '#46d3c0',
      dashboardUrl: `${appUrl}/dashboard?site=${encodeURIComponent(siteId)}`,
      settingsUrl: `${appUrl}/dashboard?site=${encodeURIComponent(siteId)}`,
      year: window.to.getFullYear(),
    },
    subject,
  })

  // Delivery failure comes back as `success: false` rather than throwing, so the
  // return value has to be read — counting the call instead reports "sent" against
  // a refused SMTP connection.
  const result = await mail.send({
    to: [to],
    from: {
      name: config.email?.from?.name || appName,
      address: config.email?.from?.address || 'hello@analyticshq.org',
    },
    subject,
    html,
    text,
  })

  return result?.success !== false
}

export default sendAnalyticsAlert
