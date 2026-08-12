/**
 * Getting a fired alert to wherever the customer asked for it (#24).
 *
 * Three channels, one contract: every send returns a boolean and none of them
 * throws. A site with an email and a Slack channel must still get the Slack
 * message when the mail server is down, so a failure in one channel is recorded
 * and the loop continues.
 *
 * ## The webhook URL is re-checked here
 *
 * `url-safety.ts` explains why a user-supplied URL is an SSRF primitive. What
 * matters at this layer is that the check runs *again*, immediately before the
 * request, rather than being trusted because it passed when the channel was
 * saved. DNS is mutable: a hostname that resolved to a public address at write
 * time can be repointed at the instance metadata service afterwards, and a
 * write-time-only check would never look again.
 *
 * `redirect: 'error'` is load-bearing for the same reason. Every check runs
 * against the URL we were given, so a 302 to `http://169.254.169.254/` would
 * launder a request straight past all of it — fetch follows redirects by default,
 * which makes the default the wrong one here.
 */

import type { AlertRow, Evaluation } from '../Analytics/alerts'
import { log } from '@stacksjs/cli'
import { config } from '@stacksjs/config'
import { headlineFor, metricLabel, windowLabel } from '../Mail/AnalyticsAlert'
import { sendAnalyticsAlert } from '../Mail/AnalyticsAlert'
import { checkWebhookUrl } from './url-safety'

export type ChannelType = 'email' | 'slack' | 'webhook'

export interface AlertChannel {
  type: ChannelType
  /** email only. */
  to?: string
  /** slack and webhook only. */
  url?: string
}

export interface DeliveryContext {
  alert: AlertRow
  siteId: string
  siteName: string
  evaluation: Evaluation
  window: { from: Date, to: Date }
}

/** Outbound requests get a short leash — a hung webhook must not stall the run. */
const TIMEOUT_MS = 10_000

export function isChannelType(v: unknown): v is ChannelType {
  return v === 'email' || v === 'slack' || v === 'webhook'
}

/**
 * Parse and validate the `channels` column.
 *
 * Anything unrecognised is dropped rather than defaulted. A malformed channel is
 * a channel nobody can receive on, and inventing a destination for it would mean
 * sending a customer's traffic data somewhere they did not ask for.
 */
export function parseChannels(raw: string | null): AlertChannel[] {
  if (!raw)
    return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return []
  }
  if (!Array.isArray(parsed))
    return []

  return parsed.flatMap((entry): AlertChannel[] => {
    if (!entry || typeof entry !== 'object')
      return []
    const { type, to, url } = entry as Record<string, unknown>
    if (!isChannelType(type))
      return []
    if (type === 'email')
      return typeof to === 'string' && to.includes('@') ? [{ type, to }] : []
    return typeof url === 'string' && url ? [{ type, url }] : []
  })
}

/** The JSON body a generic webhook receives. Documented, versioned by `type`. */
export function webhookPayload(context: DeliveryContext): Record<string, unknown> {
  const { alert, siteId, siteName, evaluation, window } = context
  const appUrl = config.app?.url || 'https://analyticshq.org'

  return {
    type: 'analytics.alert',
    firedAt: window.to.toISOString(),
    alert: {
      id: alert.id,
      name: alert.name,
      metric: alert.metric,
      condition: alert.condition,
      threshold: Number(alert.threshold),
    },
    site: {
      id: siteId,
      name: siteName,
    },
    observed: evaluation.observed,
    baseline: evaluation.baseline,
    changePct: evaluation.changePct,
    reason: evaluation.reason,
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      minutes: Number(alert.window_minutes),
    },
    dashboardUrl: `${appUrl}/dashboard?site=${encodeURIComponent(siteId)}`,
  }
}

/** What Slack's incoming-webhook endpoint renders. */
export function slackPayload(context: DeliveryContext): Record<string, unknown> {
  const { alert, siteName, evaluation } = context
  const appUrl = config.app?.url || 'https://analyticshq.org'
  const headline = headlineFor(alert, evaluation)
  const dashboardUrl = `${appUrl}/dashboard?site=${encodeURIComponent(context.siteId)}`

  // `text` is not decoration: Slack uses it for the notification preview and for
  // clients that cannot render blocks, so a blocks-only message arrives blank.
  return {
    text: `${headline} — ${siteName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${headline}*\n${siteName} · ${windowLabel(Number(alert.window_minutes))}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*${metricLabel(alert.metric)}*\n${evaluation.observed}` },
          ...(evaluation.baseline === null ? [] : [{ type: 'mrkdwn', text: `*Usually*\n${evaluation.baseline}` }]),
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `<${dashboardUrl}|Open dashboard> · ${evaluation.reason}` }],
      },
    ],
  }
}

/**
 * POST JSON to a URL the customer supplied.
 *
 * Returns false and logs on every failure path, including a refused URL — a
 * rejected webhook is a delivery failure the operator should see, not an
 * exception that stops the other channels.
 */
export async function postJson(url: string, body: unknown): Promise<boolean> {
  const verdict = await checkWebhookUrl(url)
  if (!verdict.ok) {
    log.warn(`[alerts] refusing webhook ${url}: ${verdict.reason}`)
    return false
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'analyticshq-alerts/1.0',
      },
      body: JSON.stringify(body),
      // Load-bearing. See the header comment: a redirect is a way to reach an
      // address that was never checked.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      log.warn(`[alerts] webhook ${url} returned ${response.status}`)
      return false
    }
    return true
  }
  catch (error) {
    log.warn(`[alerts] webhook ${url} failed`, error)
    return false
  }
}

/**
 * Send one fired alert to every channel configured on it.
 *
 * Each channel is independent: one failure is counted and the rest still run.
 */
export async function deliver(context: DeliveryContext): Promise<{ delivered: number, failed: number }> {
  const channels = parseChannels(context.alert.channels)
  let delivered = 0
  let failed = 0

  for (const channel of channels) {
    let ok = false
    try {
      if (channel.type === 'email' && channel.to) {
        ok = await sendAnalyticsAlert({
          to: channel.to,
          siteId: context.siteId,
          siteName: context.siteName,
          alert: context.alert,
          evaluation: context.evaluation,
          window: context.window,
        })
      }
      else if (channel.type === 'slack' && channel.url) {
        ok = await postJson(channel.url, slackPayload(context))
      }
      else if (channel.type === 'webhook' && channel.url) {
        ok = await postJson(channel.url, webhookPayload(context))
      }
    }
    catch (error) {
      // One bad channel must not stop the others, and must not stop the alert
      // run reaching the next site.
      log.error(`[alerts] channel ${channel.type} threw for alert ${context.alert.id}`, error)
      ok = false
    }

    if (ok)
      delivered++
    else
      failed++
  }

  return { delivered, failed }
}
