---
title: Install tracking
description: Install the AnalyticsHQ tracker in HTML, Stacks, Nuxt, Vue, React, or Next.js.
---

# Install tracking

The tracker should load once per document. Use the exact origin and App ID shown in the site dashboard.

## Plain HTML

```html
<script defer src="https://analyticshq.org/script.js" data-site="YOUR_APP_ID"></script>
```

## Stacks and stx

```bash
bun add @ts-analytics/tracking
```

```ts
import { tsAnalyticsStxConfig } from '@ts-analytics/tracking/stx'

export default {
  analytics: tsAnalyticsStxConfig({
    appId: 'YOUR_APP_ID',
    apiEndpoint: 'https://analyticshq.org',
  }),
}
```

Put the block in `config/ui.ts` for a Stacks app or `stx.config.ts` for a standalone stx site.

## Nuxt

```bash
bun add @ts-analytics/tracking
```

```ts
export default defineNuxtConfig({
  modules: ['@ts-analytics/tracking/nuxt'],
  tsAnalytics: {
    appId: 'YOUR_APP_ID',
    apiEndpoint: 'https://analyticshq.org',
  },
})
```

## Vue 3

```ts
import { tsAnalytics } from '@ts-analytics/tracking/vue'

createApp(App)
  .use(tsAnalytics, {
    appId: 'YOUR_APP_ID',
    apiEndpoint: 'https://analyticshq.org',
  })
  .mount('#app')
```

## React and Vite

Put the plain script tag in `index.html`. Loading it from a component can attach tracking more than once during remounts.

## Next.js

Use `next/script` in `app/layout.tsx`:

```tsx
import Script from 'next/script'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script
          src="https://analyticshq.org/script.js"
          data-site="YOUR_APP_ID"
          strategy="afterInteractive"
        />
      </body>
    </html>
  )
}
```

## Tracker options

| Attribute | Purpose |
| --- | --- |
| `data-site` | Required App ID |
| `data-respect-dnt="false"` | Allows the browser tracker to run when DNT is set; server-side GPC protection still applies |
| `data-vitals="false"` | Disables Core Web Vitals for this site |

The dashboard always shows a snippet based on the current host or verified custom domain. Prefer it over a copied example.
