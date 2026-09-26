/**
 * Where the public demo lives. Its own module, with no imports, so a marketing
 * page can link to the demo without loading the traffic generator beside it
 * (app/Analytics/demo.ts).
 */

export const DEMO_SITE_ID = 'analyticshq-demo'

/**
 * Public on purpose: it is in every demo link. Same 32-hex shape the share
 * endpoint mints, which the dashboard compares against exactly.
 */
export const DEMO_SHARE_TOKEN = '5d3a9c0e7b1f4a6d8e2c0b9a7f1e3d5c'

/** Every "Live demo" and "See a live dashboard" link opens this. */
export const DEMO_DASHBOARD_PATH = `/dashboard?site=${DEMO_SITE_ID}&share=${DEMO_SHARE_TOKEN}`
