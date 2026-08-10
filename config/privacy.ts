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

import { retentionDays } from '../scripts/analytics/lib'

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

  collect: {
    pageTitle: false,
    screenSize: false,
  },
} satisfies PrivacyConfig
