/**
 * Copy for the /compare/* pages.
 *
 * The eight comparison pages were byte-identical in markup and differed only in
 * this content, so the markup now lives once in
 * resources/partials/compare-page.stx and each view is a thin file that picks
 * its entry from here.
 *
 * Why eight views rather than one `[slug].stx` dynamic route: a dynamic route
 * would answer 200 for ANY slug. `responseStatus` is resolved from a static
 * regex over the file source before the page renders
 * (bun-plugin-stx serve.js:9615 → stx extractPageResponseStatus), so a server
 * block cannot decide to 404 — `definePageMeta({ status })` only takes a
 * literal. Collapsing to one route would turn today's hard 404 on
 * /compare/anything into an indexable soft-200. One file per real page keeps the
 * 404, and the duplication this was meant to remove is gone either way.
 */

export interface CompareRow {
  /** What is being compared. */
  dim: string
  /** Their side. */
  them: string
  /** Ours. */
  us: string
}

export interface CompareReason {
  /** Display number, e.g. '01'. */
  n: string
  /** Heading. */
  h: string
  /** Body copy. */
  b: string
}

export interface CompareMetric {
  /** Big value, e.g. '< 2 KB'. */
  v: string
  /** Supporting label. */
  l: string
}

export interface CompareRelated {
  /** Competitor slug, or '' for the /compare index. */
  slug: string
  name: string
  desc: string
}

export interface CompareLink {
  to: string
  label: string
}

export interface Competitor {
  /** URL segment, and the key in `competitors`. */
  slug: string
  /** Breadcrumb leaf, e.g. 'Google Analytics'. */
  name: string
  meta: {
    canonical: string
    title: string
    description: string
  }
  /** Hero eyebrow, e.g. 'analyticshq vs Fathom'. */
  kicker: string
  /** Hero headline. */
  h1: string
  /** Hero paragraph. */
  intro: string
  /** Hero's secondary button. The primary is always "Get your script tag". */
  heroCta: CompareLink
  /** Eyebrow above the comparison grid. */
  eyebrow: string
  /** Optional paragraph under the "where we go further" heading. */
  sectionIntro?: string
  /**
   * Optional "where they lead" aside — an honest note about what the competitor
   * does better. Only three pages carry one.
   */
  aside?: {
    ariaLabel: string
    body: string
    link: CompareLink
  }
  whyHeading: string
  ctaHeading: string
  /** Closing band's secondary button. */
  ctaLink: CompareLink
  rows: CompareRow[]
  reasons: CompareReason[]
  metrics: CompareMetric[]
  related: CompareRelated[]
}

const SEE_DASHBOARD: CompareLink = { to: '/dashboard', label: 'See a live dashboard' }
const HOW_PRIVACY_WORKS: CompareLink = { to: '/features/privacy', label: 'How the privacy works' }

export interface Crumb {
  name: string
  /** Absent on the current page, which renders as plain text. */
  href?: string
  /** Absolute form, for the BreadcrumbList JSON-LD. */
  url?: string
}

/**
 * Breadcrumb trail for a comparison page.
 *
 * One array drives BOTH the JSON-LD and the visible nav, so the two cannot
 * drift — which is how the per-page copies were written, kept here.
 */
export function crumbsFor(competitor: Competitor): Crumb[] {
  return [
    { name: 'Home', href: '/', url: 'https://analyticshq.org/' },
    { name: 'Compare', href: '/compare', url: 'https://analyticshq.org/compare' },
    { name: competitor.name },
  ]
}

export const competitors: Record<string, Competitor> = {
  'fathom': {
    slug: 'fathom',
    name: 'Fathom',
    meta: {
      canonical: 'https://analyticshq.org/compare/fathom',
      title: 'analyticshq vs Fathom Analytics - two cookieless tools compared',
      description: 'Both privacy-first and cookieless. Where analyticshq differs from Fathom: open source, self-hostable on your own PostgreSQL, and country-only geo by design.',
    },
    kicker: 'analyticshq vs Fathom',
    h1: 'Two cookieless tools. One you can host yourself.',
    intro: 'Fathom is a respected, privacy-first analytics product — cookieless, exact, and easy on the eye. analyticshq shares those foundations and adds open source, full data ownership in your own PostgreSQL, and a country-only geo line that never moves.',
    heroCta: HOW_PRIVACY_WORKS,
    eyebrow: 'Fathom vs analyticshq',
    whyHeading: 'Where analyticshq goes further.',
    ctaHeading: 'Cookieless, exact, and yours to host.',
    ctaLink: SEE_DASHBOARD,
    rows: [
      { dim: 'Source', them: 'Closed-source SaaS', us: 'Open source, and you can read every line.' },
      { dim: 'Where your data lives', them: 'Fathom’s infrastructure, reports handed back to you', us: 'Your own PostgreSQL — you hold the raw events, not just charts.' },
      { dim: 'Geography', them: 'City-level location', us: 'Country-only, on purpose — a stricter privacy line.' },
      { dim: 'Cookies and consent', them: 'Cookieless, no banner', us: 'Cookieless, no banner — same footing here.' },
      { dim: 'Revenue tracking', them: 'Per-event value with currency', us: 'Goals and events today; per-event revenue on the roadmap.' },
      { dim: 'Hosting and EU', them: 'Managed SaaS with EU Isolation for EU visitors', us: 'Self-host anywhere, or run it in the region you choose.' },
      { dim: 'Ecosystem', them: 'Polished single-dashboard product', us: 'Native to the Stacks toolchain and your own stack.' },
    ],
    reasons: [
      { n: '01', h: 'Own the data, not just the dashboard', b: 'Fathom is a well-built closed SaaS — you get clean reports, but the raw events live on their servers. analyticshq writes every event to a PostgreSQL database you control, so the underlying data is yours to query, export, or keep.' },
      { n: '02', h: 'Country-only, held on principle', b: 'Fathom resolves visitors to city level. analyticshq deliberately stops at country, resolved on your own server, keeping the aggregate-only line as strict as it goes.' },
      { n: '03', h: 'Open and self-hostable', b: 'Read the source, run it on your own infrastructure, and audit exactly what is collected. Fathom’s EU Isolation and per-event revenue are genuinely strong; analyticshq trades that polish for openness and full data ownership.' },
    ],
    metrics: [
      { v: 'Open', l: 'Source you can read and self-host, versus a closed SaaS.' },
      { v: 'Country-only', l: 'Geo stops at country by design — stricter than city-level.' },
      { v: 'Your DB', l: 'Raw events land in your PostgreSQL, not a vendor’s.' },
    ],
    related: [
      { slug: 'plausible', name: 'vs Plausible', desc: 'Another cookieless peer, compared.' },
      { slug: 'simple-analytics', name: 'vs Simple Analytics', desc: 'Aggregate-only analytics, side by side.' },
      { slug: '', name: 'All alternatives', desc: 'Every privacy-first alternative, compared.' },
    ],
  },

  'plausible': {
    slug: 'plausible',
    name: 'Plausible',
    meta: {
      canonical: 'https://analyticshq.org/compare/plausible',
      title: 'analyticshq vs Plausible - privacy-first analytics, compared',
      description: 'Two cookieless, privacy-first analytics tools compared. Where analyticshq goes further: your own PostgreSQL database and country-only geolocation.',
    },
    kicker: 'analyticshq vs Plausible',
    h1: 'Two privacy-first tools. One keeps your data in your database.',
    intro: 'Plausible is a respected, cookieless analytics tool, and on the basics the two are close: no cookies, no consent banner, exact counts. The difference is where your data lives and how far the privacy line is drawn.',
    heroCta: HOW_PRIVACY_WORKS,
    eyebrow: 'Plausible vs analyticshq',
    sectionIntro: 'Plausible does plenty analyticshq does not — funnels, Search Console, a Looker connector, spike alerts. If those are what you need, it is an excellent choice. Here is where analyticshq leads instead.',
    whyHeading: 'Where analyticshq goes further.',
    // Typographic apostrophe, matching every other possessive in this file
    // ("Fathom’s", "Umami’s"). The original was a straight quote inline in the
    // markup; through `{{ }}` that escapes to &#39;, which renders the same but
    // was the only inconsistent apostrophe in the copy.
    ctaHeading: 'Your numbers. Your visitors’ privacy. Your database.',
    ctaLink: SEE_DASHBOARD,
    rows: [
      { dim: 'Cookies and consent', them: 'Cookieless, no banner — genuinely privacy-first', us: 'Cookieless, no banner — the same baseline.' },
      { dim: 'Where your data lives', them: 'Plausible Cloud hosts it on their EU servers', us: 'Your own PostgreSQL database, wherever you run it.' },
      { dim: 'Geolocation', them: 'Resolves to city level', us: 'Country only, on purpose — the stricter line.' },
      { dim: 'Accuracy', them: 'Exact, no sampling', us: 'Exact, no sampling — the same.' },
      { dim: 'Visitor identity', them: '24-hour rotating salt', us: '24-hour rotating, per-site hash — the same.' },
      { dim: 'Ecosystem', them: 'Standalone SaaS, self-hostable', us: 'Native to the Stacks toolchain: Postgres, queues, deploy.' },
      { dim: 'Licence', them: 'Open source (AGPL)', us: 'Open source, and Postgres-native.' },
    ],
    reasons: [
      { n: '01', h: 'Your data, in your own database', b: 'Plausible is a great cookieless tool, but on Plausible Cloud your analytics live on their servers. analyticshq writes every event to a PostgreSQL table you own and can query directly — no separate store to trust.' },
      { n: '02', h: 'Country-only, on purpose', b: 'Plausible now resolves visitor location to city level. analyticshq deliberately stops at country, keeping the stricter privacy line and nothing more granular than it needs.' },
      { n: '03', h: 'Part of your stack, not another service', b: 'analyticshq runs inside the Stacks toolchain, on the same Postgres, queue, and deploy you already operate. There is no extra analytics service to run alongside your app.' },
    ],
    metrics: [
      { v: 'Country-only', l: 'No city, region, or coordinates — ever. Stricter than city-level geo.' },
      { v: 'Your Postgres', l: 'Every event lands in a database you own, not a managed store.' },
      { v: '24h', l: 'Rotating per-site hash: no cross-day and no cross-site identity.' },
    ],
    related: [
      { slug: 'fathom', name: 'vs Fathom', desc: 'How the cookieless options compare.' },
      { slug: 'simple-analytics', name: 'vs Simple Analytics', desc: 'Aggregate-only analytics, side by side.' },
      { slug: '', name: 'All alternatives', desc: 'Every analytics alternative, compared.' },
    ],
  },

  'google-analytics': {
    slug: 'google-analytics',
    name: 'Google Analytics',
    meta: {
      canonical: 'https://analyticshq.org/compare/google-analytics',
      title: 'analyticshq vs Google Analytics - privacy-first alternative',
      description: 'A cookieless, GDPR-friendly alternative to Google Analytics 4. Exact counts, no consent banner, your data in your own PostgreSQL, and one-click GA import.',
    },
    kicker: 'analyticshq vs Google Analytics',
    h1: 'The GA4 alternative that skips the cookie banner.',
    intro: 'Google Analytics was built to feed an ad network, which is why it needs consent, samples your data, and hands it to Google. analyticshq answers one question, how your site is doing, without touching your visitors’ privacy.',
    heroCta: { to: '/features/import', label: 'Import from GA' },
    eyebrow: 'GA4 vs analyticshq',
    whyHeading: 'Why teams leave Google Analytics.',
    ctaHeading: 'Leave GA. Keep your history.',
    ctaLink: { to: '/features/import', label: 'See the import guide' },
    rows: [
      { dim: 'Consent', them: 'Cookie banner and Consent Mode v2 required in the EU', us: 'Cookieless. Nothing stored on the device, so no banner.' },
      { dim: 'Where your data goes', them: 'Into the Google ad graph, shared across Google products', us: 'Into your own PostgreSQL database, and nowhere else.' },
      { dim: 'Accuracy', them: 'Sampled and thresholded once traffic grows', us: 'Every event counted, exact numbers, no sampling.' },
      { dim: 'Legality in the EU', them: 'Found unlawful by several EU DPAs over US transfers (2022–23)', us: 'No personal data collected, so there is nothing to transfer.' },
      { dim: 'Script weight', them: 'About 50 KB of gtag.js, widely ad-blocked', us: 'Under 2 KB, first-party, counts even with blockers.' },
      { dim: 'Learning curve', them: 'Explorations, dimensions, and a manual to read', us: 'One screen with the reports you actually open.' },
      { dim: 'Leaving', them: 'Export is a project', us: 'One-click GA import in, full export out, both ways.' },
    ],
    reasons: [
      { n: '01', h: 'GA4 answers to advertisers, not to you', b: 'Google Analytics exists to feed audience data into the ad network. The reports are a by-product. analyticshq has one job: tell you how your site is doing.' },
      { n: '02', h: 'No cookie banner, no Consent Mode', b: 'Because nothing is written to a visitor device, there is no consent to collect and no banner to bolt on. Your pages load clean.' },
      { n: '03', h: 'Your numbers stay yours', b: 'Events land in a PostgreSQL database you control instead of Google’s. Nothing is sampled, sold, or cross-referenced against another property.' },
    ],
    metrics: [
      { v: '< 2 KB', l: 'First-party script versus roughly 50 KB of gtag.js.' },
      { v: '0', l: 'Cookies set, consent banners shown, or personal data stored.' },
      { v: '1 click', l: 'Import your GA history and keep the charts you already track.' },
    ],
    related: [
      { slug: 'plausible', name: 'vs Plausible', desc: 'Two privacy-first tools, side by side.' },
      { slug: 'fathom', name: 'vs Fathom', desc: 'How the cookieless options compare.' },
      { slug: '', name: 'All alternatives', desc: 'Every Google Analytics alternative, compared.' },
    ],
  },

  'matomo': {
    slug: 'matomo',
    name: 'Matomo',
    meta: {
      canonical: 'https://analyticshq.org/compare/matomo',
      title: 'analyticshq vs Matomo - the lightweight, always-cookieless alternative',
      description: 'Matomo is a powerful, full behavioral suite. analyticshq is the lightweight, always-cookieless, aggregate-only alternative: no consent banner, under 2 KB, data in your own PostgreSQL.',
    },
    kicker: 'analyticshq vs Matomo',
    h1: 'The privacy suite, minus the weight.',
    intro: 'Matomo is a powerful open-source GA replacement with a full behavioral suite — recordings, heatmaps, funnels, A/B tests. If you want all of that, it is a genuinely good pick. analyticshq goes the other way: always cookieless, aggregate-only, and light enough to forget it is there.',
    heroCta: HOW_PRIVACY_WORKS,
    eyebrow: 'Matomo vs analyticshq',
    whyHeading: 'Where analyticshq fits instead.',
    ctaHeading: 'Privacy-first, without the overhead.',
    ctaLink: SEE_DASHBOARD,
    rows: [
      { dim: 'Cookies and consent', them: 'Sets cookies when behavioral features are on; can run cookieless with reduced accuracy', us: 'Always cookieless. Nothing stored on the device, so no banner.' },
      { dim: 'Script weight', them: 'Heavy tracker plus a full PHP/MySQL or cloud stack to run', us: 'Under 2 KB, first-party, on a lean Postgres and Stacks stack.' },
      { dim: 'Approach', them: 'Full behavioral suite: recordings, heatmaps, funnels, A/B tests', us: 'Deliberately aggregate-only — the reports you actually open.' },
      { dim: 'Session recordings and heatmaps', them: 'Included (individual-level tracking of real sessions)', us: 'Not offered by design; nothing is recorded per person.' },
      { dim: 'Setup and hosting', them: 'Self-host the LAMP stack, or pay for Matomo Cloud', us: 'Drop in a one-line script; your data lands in your Postgres.' },
      { dim: 'Where your data lives', them: 'Your Matomo instance, or Matomo Cloud', us: 'Your own PostgreSQL database, and nowhere else.' },
      { dim: 'Simplicity', them: 'A GA-scale console with a lot to configure', us: 'One screen, no manual, running in a minute.' },
    ],
    reasons: [
      { n: '01', h: 'Cookieless without an asterisk', b: 'Matomo can run cookieless, but you trade away accuracy and features to get there, and the full suite sets cookies. analyticshq is cookieless on every plan, with no banner and nothing to configure.' },
      { n: '02', h: 'Light where Matomo is heavy', b: 'Matomo is a full LAMP application with a large tracker. analyticshq is an under-2 KB first-party script writing to a Postgres table, so there is far less to run, host, and keep patched.' },
      { n: '03', h: 'Aggregate on purpose', b: 'Matomo records and replays individual sessions. analyticshq never does — it answers how your site is doing at the aggregate level, which is exactly why there is no personal data to manage.' },
    ],
    metrics: [
      { v: '< 2 KB', l: 'First-party script versus Matomo’s heavier tracker.' },
      { v: '0', l: 'Cookies set, consent banners shown, or sessions recorded.' },
      { v: '1 table', l: 'Events land in your own PostgreSQL, not a LAMP stack to run.' },
    ],
    related: [
      { slug: 'google-analytics', name: 'vs Google Analytics', desc: 'The GA4 alternative with no cookie banner.' },
      { slug: 'umami', name: 'vs Umami', desc: 'Open-source analytics, and where the privacy lines are drawn.' },
      { slug: '', name: 'All alternatives', desc: 'Every Google Analytics alternative, compared.' },
    ],
  },

  'mixpanel': {
    slug: 'mixpanel',
    name: 'Mixpanel',
    meta: {
      canonical: 'https://analyticshq.org/compare/mixpanel',
      title: 'analyticshq vs Mixpanel - privacy-first web analytics vs product analytics',
      description: 'Mixpanel is deep product analytics built on user-level tracking, cookies, and a heavy SDK. analyticshq is cookieless web analytics: lightweight, exact, and privacy-first, with no consent banner and data you own.',
    },
    kicker: 'analyticshq vs Mixpanel',
    h1: 'Two different jobs. Pick the one you actually have.',
    intro: 'Mixpanel is deep product analytics, built on per-user tracking to model cohorts and journeys. analyticshq is privacy-first web analytics: how your site and marketing perform, counted exactly, with no cookies, no consent banner, and data you own.',
    heroCta: HOW_PRIVACY_WORKS,
    eyebrow: 'Mixpanel vs analyticshq',
    aside: {
      ariaLabel: 'Where Mixpanel leads',
      body: 'Where Mixpanel leads: for genuine product analytics it does things analyticshq deliberately does not. Cross-session funnels, cohort retention, per-user profiles, and experimentation are its whole point. If you need to follow individual users through a product, Mixpanel is the right tool, and analyticshq is not trying to replace it.',
      link: { to: '/features/goals', label: 'See what events we do track' },
    },
    whyHeading: 'Why teams pick analyticshq instead.',
    ctaHeading: 'Measuring a website, not profiling its visitors.',
    ctaLink: SEE_DASHBOARD,
    rows: [
      { dim: 'What it is', them: 'Product analytics: per-user journeys, cohorts, funnels.', us: 'Web analytics: traffic, sources, and lightweight conversions.' },
      { dim: 'Cookies and identity', them: 'Cookies and a persistent user identity across sessions.', us: 'Cookieless. A daily rotating hash, no cross-session profile.' },
      { dim: 'Consent banner', them: 'Personal data, so a consent banner and DPA are required.', us: 'No personal data, so no banner and nothing to consent to.' },
      { dim: 'Script weight', them: 'A full JavaScript SDK, tens of KB before you send an event.', us: 'Under 2 KB, first-party, loaded once and deferred.' },
      { dim: 'Where your data lives', them: 'In the Mixpanel cloud.', us: 'In your own PostgreSQL database, and nowhere else.' },
      { dim: 'Open source and self-host', them: 'Proprietary and hosted only.', us: 'MIT-licensed and self-hostable on your own box.' },
      { dim: 'Pricing', them: 'Free tier, then usage-based pricing that climbs with events.', us: 'Free tier, flat Pro, and free forever if you self-host.' },
    ],
    reasons: [
      { n: '01', h: 'Most teams do not need per-user tracking', b: 'Mixpanel profiles every visitor to build cohorts and journeys. If your real question is how your site and marketing are doing, that machinery is overkill and a privacy liability. analyticshq answers it without identifying anyone.' },
      { n: '02', h: 'No consent banner, no SDK weight', b: 'Because analyticshq stores no personal data, there is no banner to bolt on and no DPA to sign. The whole script is under 2 KB, versus a product-analytics SDK that loads before it does anything.' },
      { n: '03', h: 'Your numbers stay yours', b: 'Events land in a PostgreSQL database you control instead of a vendor cloud, priced per event. Nothing is sampled, and nothing is metered against a plan.' },
    ],
    metrics: [
      { v: '< 2 KB', l: 'First-party script versus a full product-analytics SDK of tens of KB.' },
      { v: '0', l: 'Cookies set, user profiles built, or consent banners shown.' },
      { v: 'Flat', l: 'A predictable Pro price instead of usage-based billing that climbs with events.' },
    ],
    related: [
      { slug: 'google-analytics', name: 'vs Google Analytics', desc: 'The GA4 alternative with no cookie banner.' },
      { slug: 'plausible', name: 'vs Plausible', desc: 'Two cookieless tools, side by side.' },
      { slug: '', name: 'All alternatives', desc: 'Every analytics alternative, compared.' },
    ],
  },

  'simple-analytics': {
    slug: 'simple-analytics',
    name: 'Simple Analytics',
    meta: {
      canonical: 'https://analyticshq.org/compare/simple-analytics',
      title: 'analyticshq vs Simple Analytics - privacy-first, with the full report set',
      description: 'Both are cookieless and aggregate-only. analyticshq adds bounce rate, entry and exit pages, goals, and real-time — plus self-hosting and Postgres data ownership.',
    },
    kicker: 'analyticshq vs Simple Analytics',
    h1: 'Just as private. With the reports you actually need.',
    intro: 'Simple Analytics is admirably strict — it never even touches the IP. But its report set is the thinnest of the privacy-first tools: no bounce rate, no entry or exit pages, no conversion value. analyticshq stays cookieless and aggregate-only, and gives you the full picture — on data you own.',
    heroCta: HOW_PRIVACY_WORKS,
    eyebrow: 'Simple Analytics vs analyticshq',
    whyHeading: 'Where analyticshq goes further.',
    ctaHeading: 'Privacy-first, without the blind spots.',
    ctaLink: SEE_DASHBOARD,
    rows: [
      { dim: 'Data ownership', them: 'Closed-source SaaS (Netherlands). No self-host.', us: 'Open and self-hostable. Raw data in your own PostgreSQL.' },
      { dim: 'Bounce rate', them: 'Not reported', us: 'Bounce rate on every page and entry point' },
      { dim: 'Entry and exit pages', them: 'Not reported', us: 'Entry and exit paths, per session' },
      { dim: 'Goals and conversions', them: 'Events, but no funnels or conversion value', us: 'One-line analyticshq() goals with conversion rate and value' },
      { dim: 'Geography', them: 'Country only, inferred from timezone and UA', us: 'Country only, resolved on your own server' },
      // Was "DNT respect is on the roadmap" until #8 shipped. Kept honest in
      // both directions: they still deserve the credit for doing it first.
      { dim: 'Do Not Track', them: 'Honored — data dropped entirely (a real strength)', us: 'Honored too, by default — DNT and Global Privacy Control' },
      { dim: 'Cookies and consent', them: 'Cookieless, no banner, never touches the IP', us: 'Cookieless, no banner, IP hashed then discarded' },
    ],
    reasons: [
      { n: '01', h: 'Just as private, with the reports you actually need', b: 'Simple Analytics keeps things minimal — no bounce rate, no entry or exit pages, no conversion value. analyticshq stays cookieless and aggregate-only, but gives you the full report set teams rely on.' },
      { n: '02', h: 'You own the raw data', b: 'Simple Analytics is closed-source SaaS. analyticshq is self-hostable and Postgres-native, so the raw events live in a database you control and can query directly.' },
      { n: '03', h: 'Credit where it is due', b: 'Simple Analytics never collects the IP at all and documents honoring Do Not Track — genuinely strong privacy choices. analyticshq matches the cookieless, no-personal-data posture and adds depth and ownership on top.' },
    ],
    metrics: [
      { v: 'Full', l: 'Bounce, entry/exit, goals, and real-time — not just pageviews.' },
      { v: 'Self-host', l: 'Run it on your own Postgres and own the raw data.' },
      { v: '0', l: 'Cookies set, consent banners shown, or personal data stored.' },
    ],
    related: [
      { slug: 'plausible', name: 'vs Plausible', desc: 'Two privacy-first tools, side by side.' },
      { slug: 'umami', name: 'vs Umami', desc: 'Open-source analytics, and where the privacy lines are drawn.' },
      { slug: '', name: 'All alternatives', desc: 'Every analytics alternative, compared.' },
    ],
  },

  'umami': {
    slug: 'umami',
    name: 'Umami',
    meta: {
      canonical: 'https://analyticshq.org/compare/umami',
      title: 'analyticshq vs Umami - aggregate-only, cookieless analytics',
      description: 'Two open-source, cookieless analytics tools compared. Where analyticshq stays strictly aggregate — 24h rotating IDs, no session replay, no individual profiles — and Umami does not.',
    },
    kicker: 'analyticshq vs Umami',
    h1: 'Open source, but strictly aggregate.',
    intro: 'Umami and analyticshq are both open-source and cookieless. The difference is where the line is drawn: Umami v3 moved toward individual-level tracking with session replay and user profiles, while analyticshq stays aggregate-only — and rotates identity every 24 hours instead of monthly.',
    heroCta: HOW_PRIVACY_WORKS,
    eyebrow: 'Umami vs analyticshq',
    whyHeading: 'Where the two part ways.',
    ctaHeading: 'Aggregate by principle, not by default.',
    ctaLink: SEE_DASHBOARD,
    rows: [
      { dim: 'ID rotation window', them: 'Session salt rotates monthly, visit salt hourly', us: 'Per-site hash rotates every 24 hours. No monthly linkability.' },
      { dim: 'Session replay & heatmaps', them: 'Yes — added in v3 (replay on rrweb, heatmaps)', us: 'Never. Recording individual sessions breaks aggregate-only.' },
      { dim: 'Individual profiles', them: 'A "Sessions" view lists and drills into individual visitors', us: 'No per-person view. Reports are aggregate, full stop.' },
      { dim: 'Cross-session identity', them: 'identify() stitches a user’s sessions across time', us: 'No identify(), no distinct-ID stitching, by design.' },
      { dim: 'Geolocation', them: 'Country, region, and city', us: 'Country only, resolved locally. IP discarded.' },
      { dim: 'Open source', them: 'Yes (MIT), self-hostable', us: 'Yes — Postgres-native, self-hostable, Stacks-integrated.' },
      { dim: 'Cookies & consent', them: 'Cookieless, no banner needed', us: 'Cookieless, no banner needed.' },
    ],
    reasons: [
      { n: '01', h: 'Both are open source — the philosophy is where they split', b: 'Umami and analyticshq are both MIT-spirited and self-hostable, with cookieless defaults. The difference is the ceiling: Umami now offers individual-level tracking, analyticshq refuses to build it.' },
      { n: '02', h: 'Aggregate-only, on purpose', b: 'Umami v3 shipped session replay, heatmaps, individual visitor profiles, and identify() user stitching. analyticshq deliberately will never add any of them — there is no per-person timeline to reconstruct.' },
      { n: '03', h: 'A tighter identity window', b: 'Umami’s session salt rotates monthly. analyticshq rotates its per-site hash every 24 hours, so activity cannot be linked across days — a materially shorter linkability window.' },
    ],
    metrics: [
      { v: '24h', l: 'ID rotation window, versus Umami’s monthly session salt.' },
      { v: '0', l: 'Session recordings, heatmaps, or individual profiles — ever.' },
      { v: 'Country', l: 'Geo granularity. No region or city is stored.' },
    ],
    related: [
      { slug: 'plausible', name: 'vs Plausible', desc: 'Two aggregate-first tools, side by side.' },
      { slug: 'matomo', name: 'vs Matomo', desc: 'The lighter, cookieless alternative.' },
      { slug: '', name: 'All alternatives', desc: 'Every analytics alternative, compared.' },
    ],
  },

  'cloudflare': {
    slug: 'cloudflare',
    name: 'Cloudflare',
    meta: {
      canonical: 'https://analyticshq.org/compare/cloudflare',
      title: 'analyticshq vs Cloudflare Web Analytics - the privacy-first alternative',
      description: 'Cloudflare Web Analytics is free and cookieless, but read-only on pageviews and locked to Cloudflare. analyticshq adds custom events, data you own in PostgreSQL, and self-hosting, while staying cookieless.',
    },
    kicker: 'analyticshq vs Cloudflare Web Analytics',
    h1: 'Cookieless like Cloudflare, but the data is yours.',
    intro: 'Cloudflare Web Analytics is a solid free pageview counter, and like analyticshq it sets no cookies. The difference is depth and ownership: analyticshq adds custom events and goals, stores every event in your own PostgreSQL, and runs on any host, not just behind Cloudflare.',
    heroCta: { to: '/features/goals', label: 'See events and goals' },
    eyebrow: 'Cloudflare vs analyticshq',
    aside: {
      ariaLabel: 'Where Cloudflare leads',
      body: 'Where Cloudflare leads: it is genuinely free, and if your site already runs behind Cloudflare it is zero extra script and zero config. For a no-frills pageview count with nothing to manage, it is hard to beat on price.',
      link: { to: '/pricing', label: 'See how our pricing works' },
    },
    whyHeading: 'Why teams switch from Cloudflare.',
    ctaHeading: 'Keep the privacy. Add the events, and the ownership.',
    ctaLink: SEE_DASHBOARD,
    rows: [
      { dim: 'Cookies and consent', them: 'Cookieless, no banner. A genuine privacy peer.', us: 'Cookieless, no banner, no personal data stored.' },
      { dim: 'Custom events and goals', them: 'None. Pageviews, referrers, and top paths only.', us: 'One-line analyticshq() events, goals, and UTM campaigns.' },
      { dim: 'Where your data lives', them: 'Inside Cloudflare. You read it, you do not hold it.', us: 'Your own PostgreSQL database, and nowhere else.' },
      { dim: 'Open source and self-host', them: 'Proprietary and hosted. No self-host option.', us: 'MIT-licensed and self-hostable on your own box.' },
      { dim: 'Ties to one provider', them: 'At its best when your site is proxied through Cloudflare.', us: 'Works on any host or CDN with one script tag.' },
      { dim: 'Real-time', them: 'Reports refresh on a delay, not live.', us: 'A live view of who is on the site right now.' },
      { dim: 'Price', them: 'Free.', us: 'Free tier, flat Pro, and free forever if you self-host.' },
    ],
    reasons: [
      { n: '01', h: 'Events, not just a pageview counter', b: 'Cloudflare Web Analytics counts pages and referrers and stops there. analyticshq fires a conversion with a one-line analyticshq() call, so signups, purchases, and custom events sit beside your traffic.' },
      { n: '02', h: 'You hold the data, not just a dashboard', b: 'Cloudflare shows you the numbers but keeps them. With analyticshq every raw event lands in a PostgreSQL database you own, ready to query, export, or self-host.' },
      { n: '03', h: 'Not tied to one network', b: 'Cloudflare Analytics is happiest when your site already runs behind Cloudflare. analyticshq is a single first-party script that works on any host, CDN, or framework.' },
    ],
    metrics: [
      { v: 'Cookieless', l: 'Like Cloudflare, no cookies and no consent banner. Where analyticshq goes further is events and ownership.' },
      { v: 'Your DB', l: 'Every event stored in your own PostgreSQL, not held inside a provider dashboard.' },
      { v: 'Any host', l: 'One script tag, no requirement to proxy your traffic through a specific network.' },
    ],
    related: [
      { slug: 'plausible', name: 'vs Plausible', desc: 'Two cookieless tools, side by side.' },
      { slug: 'simple-analytics', name: 'vs Simple Analytics', desc: 'Aggregate-only analytics, compared.' },
      { slug: '', name: 'All alternatives', desc: 'Every analytics alternative, compared.' },
    ],
  },
}
