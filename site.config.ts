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
  // Per-route SEO overrides. Deliberately EMPTY.
  //
  // This used to carry title + description for 11 routes, every one of which is now
  // owned by the page itself through useSeoMeta -- which is the only source that also
  // produces og:* and twitter:* from the same string, so the two cannot drift. Two of
  // the entries were /dashboard and /account: injectSeo mints canonical and og
  // unconditionally for whatever path it is given, so listing auth-walled routes here
  // advertised them as indexable.
  //
  // Add a key back only for something a page genuinely cannot know -- a per-route
  // og image, say. Never a title or a description.
  pages: {},
}
