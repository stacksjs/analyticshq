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
| `data-environment="staging"` | Optional. Labels every page view, custom event, and Web Vitals measurement with the environment it came from |

### Environment label

`data-environment` is metadata only. It never turns tracking on or off: decide which environments report before you add the script, and the tracker sends whatever label the tag carries. Stacks does this for you, checking `APP_ENV` against its allowlist before it injects the snippet.

```html
<script defer src="https://analyticshq.org/script.js" data-site="YOUR_APP_ID" data-environment="staging"></script>
```

The value travels as an `environment` field on each request to `/collect`, next to the event rather than inside its properties. AnalyticsHQ trims and lowercases it, then keeps it only when it is a short label: up to 32 characters of letters, digits, `.`, `-` and `_`, starting with a letter or digit. Anything else is discarded and the event is still recorded. Without the attribute, requests are exactly what they were before it existed.

The dashboard always shows a snippet based on the current host or verified custom domain. Prefer it over a copied example.
