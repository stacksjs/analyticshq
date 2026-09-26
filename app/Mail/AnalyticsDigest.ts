import type { TemplateVariableValue } from '@stacksjs/email'
import type { SiteSummary } from '../Analytics/summary'
import { config } from '@stacksjs/config'
import { mail, template } from '@stacksjs/email'
import { delta } from '../Analytics/summary'

export interface AnalyticsDigestOptions {
  to: string
  siteId: string
  siteName: string
  summary: SiteSummary
  /** 'weekly' | 'monthly' — only used for wording. */
  cadence: string
}

/** "+12%" / "-4%" / "" when there is no previous period to compare against. */
function formatDelta(current: number, previous: number): string {
  const d = delta(current, previous)
  if (d === null)
    return ''
  return `${d >= 0 ? '+' : ''}${d}% vs previous period`
}

/** 12,480 rather than 12480 — these are read at a glance on a phone. */
function num(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Rows for the template's `@foreach`, as a template variable.
 *
 * The `.stx` renderer hands variables to the template as props, lists
 * included, but `@stacksjs/email` through 0.74.70 types a variable as a single
 * printable value. Widened upstream (stacks `core/email/src/template.ts`,
 * `TemplateVariableValue` now takes lists and records); drop this for the
 * plain array once the app is on a release that ships it.
 */
function rows(list: Array<{ label: string, views: string }>): TemplateVariableValue {
  const value: unknown = list
  return value as TemplateVariableValue
}

/** "1–8 August 2026", from two ISO strings. */
function rangeLabel(fromIso: string, toIso: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }
  const from = new Date(fromIso).toLocaleDateString('en-GB', opts)
  const to = new Date(toIso).toLocaleDateString('en-GB', opts)
  return `${from} – ${to}`
}

/**
 * Send one site's digest.
 *
 * Uses `resources/emails/analytics-digest.stx`. Everything the template renders is
 * pre-formatted here — numbers, deltas, dates — so the template holds no logic and
 * cannot decide, for instance, what "no previous period" should look like.
 */
export async function sendAnalyticsDigest(options: AnalyticsDigestOptions): Promise<boolean> {
  const { to, siteId, siteName, summary, cadence } = options

  const appName = config.app?.name || 'analyticshq'
  const appUrl = config.app?.url || 'https://analyticshq.org'
  const periodLabel = cadence === 'monthly' ? 'Last month' : 'Last week'
  const subject = `${periodLabel} on ${siteName}: ${num(summary.current.visitors)} visitors`

  const { html, text } = await template('analytics-digest', {
    variables: {
      appName,
      siteName,
      periodLabel,
      rangeLabel: rangeLabel(summary.from, summary.to),
      visitors: num(summary.current.visitors),
      views: num(summary.current.views),
      sessions: num(summary.current.sessions),
      visitorsDelta: formatDelta(summary.current.visitors, summary.previous.visitors),
      viewsDelta: formatDelta(summary.current.views, summary.previous.views),
      topPages: rows(summary.topPages.map(r => ({ label: r.label, views: num(r.views) }))),
      topSources: rows(summary.topSources.map(r => ({ label: r.label, views: num(r.views) }))),
      dashboardUrl: `${appUrl}/dashboard?site=${encodeURIComponent(siteId)}`,
      settingsUrl: `${appUrl}/dashboard?site=${encodeURIComponent(siteId)}`,
      year: new Date().getFullYear(),
    },
    subject,
  })

  // Returns a result rather than throwing: an SMTP connection failure comes back
  // as `success: false` with the error already logged by the driver. Ignoring the
  // return value means counting a message as sent while the mailer is down, which
  // is exactly what this reported before the value was checked.
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

export default sendAnalyticsDigest
