import type { AnalyticsConfig } from '@stacksjs/types'

/**
 * **Analytics Configuration**
 *
 * Which analytics this application uses *for itself*. Not to be confused with the
 * product: the sites, page views and goals under `routes/analytics.ts` are what we
 * sell. This file is one line of the same question every customer answers when they
 * paste our snippet — and until #12 we had answered it with a competitor.
 *
 * The scaffold shipped `driver: 'fathom'` with a real Fathom site id, plus a
 * placeholder `UA-XXXXXXXXX-X` for Google Analytics, on the site whose
 * /compare/google-analytics page tells readers GA "hands your data to Google". No
 * code read this file, so nothing ever loaded — the damage was not a leak but a
 * configuration that read like a decision nobody had taken.
 *
 * ## Where the tag actually comes from
 *
 * This is the Stacks-side config and nothing in this app consumes it. The tag is
 * emitted by stx, from the `analytics` block in `config/ui.ts`, which
 * `process.js` renders through `injectAnalytics()` before `</head>`. That block is
 * the one to edit; this one exists so the framework's own view of the app agrees
 * with it rather than contradicting it.
 *
 * Both are off unless `ANALYTICSHQ_SITE_ID` is set, so development and a fresh
 * checkout never beacon at production.
 */
export default {
  // 'self-hosted' is the closest driver in the framework's union to what we run:
  // our own collector, our own database, no third party. The tag itself is stx's
  // 'custom' driver pointed at public/script.js — the artifact customers install —
  // because the framework's self-hosted generator emits its own inline beacon with a
  // different payload contract than /collect accepts.
  driver: 'self-hosted',

  drivers: {
    selfHosted: {
      siteId: process.env.ANALYTICSHQ_SITE_ID || '',
      // Same-origin. public/script.js derives its collect endpoint from its own
      // src, so it follows the apex, the legacy domain, a customer CNAME or
      // localhost without being rebuilt; this value documents the intent rather
      // than configuring the tag.
      apiEndpoint: '/collect',
      // Both already enforced by the tracker and the ingest, not by this file:
      // public/script.js bails on DNT/GPC before attaching a listener, and
      // routes/analytics.ts drops any request carrying Sec-GPC.
      honorDnt: true,
      trackOutboundLinks: true,
    },
  },
} satisfies AnalyticsConfig
