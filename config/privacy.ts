/**
 * **Privacy configuration**
 *
 * The single place every privacy-affecting behaviour is declared (#11). Before
 * this file each one was a constant buried in whichever file happened to need
 * it — a daily-salt window in `app/Analytics/salt.ts`, a session window in
 * `routes/analytics.ts`, geo granularity implied by which helper got called, DNT
 * handling split between the tracker and the ingest. An operator could not see
 * what the product does, let alone change it.
 *
 * Not to be confused with `config/analytics.ts`, which configures the Stacks
 * framework's own third-party analytics driver for this marketing site — a
 * different thing entirely, and currently pointed at Fathom.
 *
 * ## The defaults are the product
 *
 * These are not neutral knobs. The defaults here are the privacy posture the
 * comparison pages claim, so changing one is a change to what we tell visitors:
 *
 * - `geo.granularity: 'country'` — `/compare/umami` says "Country only, from CDN
 *   edge headers. IP discarded." and `/compare/plausible` contrasts with their
 *   city-level resolution.
 * - `respectDnt: true` — `/compare/simple-analytics` credits them for honoring
 *   DNT and now claims parity.
 * - `collect.pageTitle` / `collect.screenSize` — both false, and both were
 *   removed outright in #10 rather than merely defaulted off.
 *
 * Loosening any of those means updating `resources/data/competitors.ts` in the
 * same change.
 */

import process from 'node:process'
import { retentionDays } from '../scripts/analytics/lib'

/**
 * `ANALYTICSHQ_MIN_SEGMENT_SIZE`, or 5.
 *
 * Deliberately NOT the same permissive rule as `retentionDays()`, where unset
 * means "disabled". Here unset must mean "protected": a mistyped env var that
 * silently switched the guard off would be a privacy regression that nothing
 * reports. Only an explicit `0` disables it.
 */
function minSegmentSize(): number {
  const raw = process.env.ANALYTICSHQ_MIN_SEGMENT_SIZE
  if (raw === undefined || raw.trim() === '')
    return 5
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0)
    return 5
  return n
}

export interface PrivacyConfig {
  /**
   * Days of raw analytics rows to keep. `0` disables pruning entirely.
   *
   * Read from `ANALYTICSHQ_RETENTION_DAYS` so a self-hoster can set it without
   * editing source; `scripts/analytics/prune.ts` runs daily off the scheduler.
   */
  retentionDays: number

  /**
   * Days of per-site visitor salts to keep, and therefore the outer bound on how
   * long a visitor hash could in principle be reversed.
   *
   * Two, not one: an event arriving just after UTC midnight must still hash
   * against the day it belongs to. Once the row is purged the day's hashes are
   * unlinkable to any input — see `app/Analytics/salt.ts`.
   */
  saltRetentionDays: number

  /** Inactivity window that ends a session, in minutes. */
  sessionWindowMinutes: number

  geo: {
    /**
     * `'country'` resolves from CDN edge headers and discards the IP.
     * `'none'` records no location at all.
     *
     * There is deliberately no city or region option. Adding one would be a
     * product decision, not a configuration change.
     */
    granularity: 'country' | 'none'
  }

  /**
   * Honor Do-Not-Track and Global Privacy Control.
   *
   * Server-side this drops any request carrying `Sec-GPC: 1`. The tracker makes
   * the same check in the browser and can be opted out per site with
   * `data-respect-dnt="false"` on the script tag — that attribute wins for that
   * site, because it is the site owner's call, but it cannot turn off the
   * server-side check.
   */
  respectDnt: boolean

  /**
   * The smallest number of distinct visitors a FILTERED report may describe (#40).
   *
   * Segments narrow a population before a count is taken, and every filter is
   * individually aggregate and innocuous. Composed, they are not: on a seeded
   * 61-visitor site, `country=IS` plus `device=tablet` matches exactly one person,
   * and a funnel over that segment reports their complete journey. That
   * contradicts the claim the whole product rests on — that nobody can identify
   * an individual visitor, the site's owner included, which is the reason there
   * is no cookie and no consent banner.
   *
   * So a filtered report describing fewer than this many visitors is refused
   * rather than served. Unfiltered totals are NEVER suppressed: "you had 3
   * visitors yesterday" identifies nobody, and hiding it would make a new install
   * look broken rather than careful.
   *
   * `0` disables the check. Read from `ANALYTICSHQ_MIN_SEGMENT_SIZE`, because an
   * operator with a stricter obligation — or a genuinely private single-user
   * install — should be able to change it without editing source.
   *
   * The cost is real and worth stating: on a low-traffic site, clicking a filter
   * can return nothing. That is the guarantee working, and the message says so,
   * but it is a visible behaviour change rather than a silent hardening.
   */
  minSegmentSize: number

  /** Fields the tracker is permitted to collect beyond the essentials. */
  collect: {
    /**
     * Page titles. Off, and #10 removed the column: a title carries page
     * content, which on a real app means personal data. Turning this on would
     * require reinstating collection deliberately.
     */
    pageTitle: boolean
    /** Screen dimensions — a passive fingerprinting vector. Removed in #10. */
    screenSize: boolean
  }
}

export default {
  // Parsed by the same helper `scripts/analytics/prune.ts` uses, rather than
  // re-implementing the "unset / 0 / negative / non-numeric = disabled" rule here.
  // lib.ts is dependency-free, so importing it costs nothing on the ingest path.
  retentionDays: retentionDays(),

  saltRetentionDays: 2,

  sessionWindowMinutes: 30,

  geo: {
    granularity: 'country',
  },

  respectDnt: true,

  // 5 is the conventional k for this kind of disclosure control and is small
  // enough that an ordinary site never notices it. Parsed permissively: anything
  // unset, negative or non-numeric means "use the default" rather than silently
  // disabling the guard — the failure mode of a typo here should be too strict,
  // never too loose. Set it explicitly to 0 to turn the check off.
  minSegmentSize: minSegmentSize(),

  collect: {
    pageTitle: false,
    screenSize: false,
  },
} satisfies PrivacyConfig
