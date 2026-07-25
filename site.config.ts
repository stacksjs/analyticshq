// Site metadata + SEO. `buddy serve` loads this and injects accurate
// <title>, canonical, Open Graph, and Twitter card tags per page (replacing
// stx's "stx App" scaffold defaults). Per-path overrides live in `pages`.
const description = 'Privacy-first, cookieless web analytics. Real-time visitors, sources, and conversions with no cookies, no consent banner, and no personal data. Powered by Stacks and PostgreSQL.'

export default {
  name: 'analyticshq',
  url: 'https://analyticshq.org',
  description,
  seo: {
    siteName: 'analyticshq',
    title: 'analyticshq - Privacy-first web analytics',
    description,
    image: 'https://analyticshq.org/og.png',
    favicon: '/favicon.svg',
    locale: 'en_US',
    type: 'website',
    twitter: 'stacksjs',
  },
  pages: {
    '/': {
      title: 'analyticshq - Privacy-first web analytics',
      description,
    },
    '/dashboard': {
      title: 'Dashboard - analyticshq',
      description: 'Real-time visitors, page views, sessions, top pages, and traffic sources for your site.',
    },
    '/account': {
      title: 'Account - analyticshq',
      description: 'Your analyticshq profile, plan, and sign-in method.',
    },
    '/use-cases': {
      title: 'Use cases - analyticshq',
      description: 'How SaaS teams, agencies, ecommerce stores, publishers, and open-source projects use cookieless analytics that respects visitors.',
    },
    '/features/real-time': {
      title: 'Real-time visitors - analyticshq',
      description: 'See who is on your site right now, which pages they are reading, and where they came from. Live, cookieless, no reload.',
    },
    '/features/metrics': {
      title: 'Pageviews, sessions and bounce - analyticshq',
      description: 'Every hit rolls up into sessions with entry and exit paths, duration, and bounce rate. Exact counts, never sampled.',
    },
    '/features/sources': {
      title: 'Traffic sources and referrers - analyticshq',
      description: 'Search, social, direct, and campaign traffic separated automatically, with UTM support and clean referrer classification.',
    },
    '/features/goals': {
      title: 'Goals, events and campaigns - analyticshq',
      description: 'Track conversions with a one-line ghost() call and tie UTM campaigns to the outcomes that matter.',
    },
    '/features/geography': {
      title: 'Geography and devices - analyticshq',
      description: 'Country, device, browser, and OS. Country resolves from your CDN edge headers, never a third-party lookup.',
    },
    '/features/web-vitals': {
      title: 'Core Web Vitals - analyticshq',
      description: 'Real-user LCP, INP, and CLS next to your traffic, so a slow page shows up before it costs you visitors.',
    },
    '/features/privacy': {
      title: 'Privacy by design - analyticshq',
      description: 'No cookies, no consent banner, no personal data. GDPR, CCPA, and PECR friendly because there is nothing personal to store.',
    },
  },
}
