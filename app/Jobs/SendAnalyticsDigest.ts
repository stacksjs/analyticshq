import { log } from '@stacksjs/cli'
import { db } from '@stacksjs/database'
import { Job } from '@stacksjs/queue'
import { siteSummary } from '../Analytics/summary'
import { sendAnalyticsDigest } from '../Mail/AnalyticsDigest'

/**
 * Email each opted-in site its period summary (#14).
 *
 * ## Opt-in
 *
 * Stored as `digest` in the site's existing `settings` JSON — the same column
 * `share_token` uses — so this needed no migration and no new table. Absent means
 * off, which is the only safe default: every address here belongs to a customer
 * who never asked for mail, and a digest nobody enabled is indistinguishable from
 * spam to both the reader and their provider.
 *
 * ## Cadence
 *
 * The scheduler runs this daily and the job decides who is due, rather than
 * registering one schedule per cadence. Weekly sends on Monday, monthly on the
 * 1st, both in UTC. Doing it here keeps "who gets mail today" in one readable
 * place instead of split across cron expressions, and means a missed run is a
 * missed day rather than a missed month.
 *
 * ## What is deliberately not sent
 *
 * A site with no page views in the period is skipped entirely. A mail reporting
 * zeroes to someone whose site is new or seasonal earns an unsubscribe at best
 * and a spam report at worst, and it carries no information the reader did not
 * already have.
 *
 * Each site is sent independently and a failure is logged, not thrown: one bad
 * address or one mailer hiccup must not stop every later site in the list from
 * being told about its week.
 */

type Cadence = 'weekly' | 'monthly'

interface DueSite {
  id: string
  name: string | null
  settings: string | null
  email: string | null
}

/** Which cadences are due on this date, in UTC. */
export function cadencesDueOn(now: Date): Cadence[] {
  const due: Cadence[] = []
  if (now.getUTCDay() === 1)
    due.push('weekly')
  if (now.getUTCDate() === 1)
    due.push('monthly')
  return due
}

/** The window a cadence reports on, ending now. */
export function windowFor(cadence: Cadence, now: Date): { from: Date, to: Date } {
  const days = cadence === 'monthly' ? 30 : 7
  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now }
}

/** The site's configured cadence, or null when digests are off. */
export function cadenceOf(settings: string | null): Cadence | null {
  try {
    const value = JSON.parse(settings || '{}')?.digest
    return value === 'weekly' || value === 'monthly' ? value : null
  }
  catch {
    // Malformed settings JSON means "not configured", not "send anyway".
    return null
  }
}

export async function runAnalyticsDigest(now: Date = new Date()): Promise<{ sent: number, skipped: number, failed: number }> {
  const due = cadencesDueOn(now)
  if (!due.length)
    return { sent: 0, skipped: 0, failed: 0 }

  // Join to users because the digest goes to the site OWNER; a site whose owner
  // was deleted has nobody to mail and is filtered out by the inner join.
  const sites = await db.unsafe(
    `SELECT s.id, s.name, s.settings, u.email
     FROM sites s JOIN users u ON u.id = s.owner_id
     WHERE s.settings IS NOT NULL AND s.settings <> ''`,
  ).catch(() => []) as DueSite[]

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const site of sites ?? []) {
    const cadence = cadenceOf(site.settings)
    if (!cadence || !due.includes(cadence) || !site.email) {
      skipped++
      continue
    }

    try {
      const { from, to } = windowFor(cadence, now)
      const summary = await siteSummary(site.id, from, to)
      if (summary.empty) {
        skipped++
        continue
      }

      // The mailer reports delivery failure as `success: false` rather than
      // throwing, so this counter has to read the return value. Counting the call
      // instead reported "sent 1" against a refused SMTP connection.
      const ok = await sendAnalyticsDigest({
        to: site.email,
        siteId: site.id,
        siteName: site.name || site.id,
        summary,
        cadence,
      })
      if (ok)
        sent++
      else
        failed++
    }
    catch (error) {
      // Logged, not rethrown: see the note above about one site not stopping the rest.
      log.error(`[digest] failed for site ${site.id}`, error)
      failed++
    }
  }

  return { sent, skipped, failed }
}

export default new Job({
  handle: async () => {
    const { sent, skipped, failed } = await runAnalyticsDigest()
    log.info(`[digest] sent ${sent}, skipped ${skipped}, failed ${failed}`)
  },
})
