import type { BunPressOptions } from '@stacksjs/bunpress'

const config: BunPressOptions = {
  verbose: false,
  docsDir: './docs',
  outDir: './dist/docs',

  nav: [
    { text: 'Quick start', link: '/getting-started' },
    { text: 'Tracking', link: '/tracking/install' },
    { text: 'Reports', link: '/reports/dashboard' },
    { text: 'Dashboard', link: 'https://analyticshq.org/dashboard' },
    { text: 'GitHub', link: 'https://github.com/stacksjs/analyticshq' },
  ],

  markdown: {
    title: 'AnalyticsHQ Documentation',
    meta: {
      description: 'Privacy-first web analytics, goals, funnels, revenue, Web Vitals, imports, and self-hosting.',
      author: 'AnalyticsHQ',
    },
    syntaxHighlightTheme: 'github-dark',
    toc: {
      enabled: true,
      minDepth: 2,
      maxDepth: 3,
    },
    sidebar: {
      '/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is AnalyticsHQ', link: '/introduction' },
            { text: 'Quick start', link: '/getting-started' },
          ],
        },
        {
          text: 'Collect data',
          items: [
            { text: 'Install tracking', link: '/tracking/install' },
            { text: 'Custom events', link: '/tracking/custom-events' },
            { text: 'Custom domains', link: '/tracking/custom-domains' },
          ],
        },
        {
          text: 'Understand traffic',
          items: [
            { text: 'Dashboard reports', link: '/reports/dashboard' },
            { text: 'Filters and segments', link: '/reports/filters-segments' },
            { text: 'Goals and funnels', link: '/reports/goals-funnels' },
            { text: 'Revenue and Web Vitals', link: '/reports/revenue-vitals' },
          ],
        },
        {
          text: 'Move data',
          items: [
            { text: 'Fathom import', link: '/imports/fathom' },
            { text: 'GA4 and Search Console', link: '/imports/google' },
            { text: 'Backup and restore', link: '/imports/backup-restore' },
          ],
        },
        {
          text: 'Manage',
          items: [
            { text: 'Teams and sharing', link: '/manage/teams-sharing' },
            { text: 'Privacy model', link: '/privacy' },
            { text: 'Self-hosting', link: '/self-hosting' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'HTTP API', link: '/reference/api' },
            { text: 'CLI', link: '/reference/cli' },
          ],
        },
      ],
    },
  },

  themeConfig: {
    darkMode: 'auto',
    footer: {
      message: 'Privacy-first analytics, released under the MIT License.',
      copyright: 'Copyright 2026-present AnalyticsHQ',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/stacksjs/analyticshq' },
    ],
  },

  sitemap: {
    enabled: true,
    baseUrl: 'https://analyticshq.org/docs',
  },

  robots: {
    enabled: true,
  },
}

export default config
