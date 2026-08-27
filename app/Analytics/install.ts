/**
 * Install instructions for the tracker, per framework.
 *
 * The dashboard used to show exactly one thing: a raw `<script>` tag with
 * `https://analyticshq.org` hardcoded into it. That is wrong twice over — it is
 * the wrong host for anyone not on production (a developer on localhost was
 * handed a snippet pointing at the live site), and a raw tag is the wrong
 * *shape* of answer for someone running Nuxt or Next, where "add it to <head>"
 * has a framework-specific place and idiom.
 *
 * ## Why the origin is a token
 *
 * These strings are built server-side and cross stx's client payload bridge, so
 * the server cannot know the origin the browser is actually on — in dev that is
 * `http://localhost:<port>` while `config.app.url` says `ghostanalytics.localhost`,
 * and behind a verified custom domain it is the customer's own host. The client
 * substitutes {@link ORIGIN_TOKEN} with `window.location.origin` at render time,
 * which is correct in every one of those cases for the same reason the share
 * link uses it (dashboard.stx:992).
 *
 * That is not a detail: the tracker derives its collector from its own `src`
 * origin (`document.currentScript.src`), so a snippet pointing at the wrong host
 * does not merely 404 — it silently collects into someone else's site.
 *
 * ## Why the script tag is a token too
 *
 * A literal `</script>` inside a value that gets serialized into an inline
 * script terminates that script tag early and takes the rest of the page's
 * bundle with it. dashboard.stx already assembles the tag name at runtime to
 * dodge this; these strings cross the same boundary, so they use
 * {@link TAG_TOKEN} / {@link ENDTAG_TOKEN} and the byte sequence never exists in
 * source or in the serialized payload.
 */

/** Replaced client-side with `window.location.origin`. */
export const ORIGIN_TOKEN = '%ORIGIN%'
/** Replaced client-side with a literal `<script`. */
export const TAG_TOKEN = '%TAG%'
/** Replaced client-side with a literal `</script>`. */
export const ENDTAG_TOKEN = '%ENDTAG%'

/** The npm package the framework integrations ship in. */
export const PACKAGE_NAME = '@ts-analytics/tracking'

export interface InstallTarget {
  /** Stable id — also the tab's value. */
  id: string
  /** Tab label. */
  label: string
  /** Where the code goes. Shown above the snippet. */
  file: string
  /** One sentence of context. */
  note: string
  /** The snippet, still carrying the tokens above. */
  code: string
}

/**
 * Give a bare host a scheme.
 *
 * `config.app.url` is stored without one (`ghostanalytics.localhost`), and
 * pasting that straight into a `src=` produces a *relative* URL that resolves
 * against the customer's own site — the tracker then 404s and the site silently
 * reports nothing. `.localhost` gets `http://` because that is what the dev
 * server serves and nothing mints a public certificate for it.
 */
export function normalizeOrigin(raw: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed)
    return ''
  if (/^https?:\/\//i.test(trimmed))
    return trimmed
  const host = trimmed.replace(/^\/+/, '')
  const local = /(?:^|\.)localhost(?::\d+)?$/i.test(host) || /^127\.0\.0\.1(?::\d+)?$/.test(host)
  return `${local ? 'http' : 'https'}://${host}`
}

/**
 * Every supported install path, in the order the tabs appear.
 *
 * Only Nuxt has a real module — the rest are placements of the same tag, which
 * is the honest answer. Listing them separately is still worth it: someone in a
 * Next app needs to be told `next/script` and `app/layout.tsx`, and telling them
 * "add it to <head>" is how installs get abandoned.
 */
export function installTargets(siteId: string): InstallTarget[] {
  const id = String(siteId ?? '')
  const tag = `${TAG_TOKEN} defer src="${ORIGIN_TOKEN}/script.js" data-site="${id}">${ENDTAG_TOKEN}`

  return [
    {
      id: 'html',
      label: 'HTML',
      file: 'index.html',
      note: 'Works on any site. Add it once, inside <head>.',
      code: tag,
    },
    {
      id: 'nuxt',
      label: 'Nuxt',
      file: 'nuxt.config.ts',
      note: `A real Nuxt module: it injects the tag and auto-imports useTsAnalytics() for custom events. SPA route changes are tracked with no router wiring.`,
      code: [
        `// bun add ${PACKAGE_NAME}`,
        ``,
        `export default defineNuxtConfig({`,
        `  modules: ['${PACKAGE_NAME}/nuxt'],`,
        `  tsAnalytics: {`,
        `    appId: '${id}',`,
        `    apiEndpoint: '${ORIGIN_TOKEN}',`,
        `  },`,
        `})`,
      ].join('\n'),
    },
    {
      id: 'vue',
      label: 'Vue',
      file: 'main.ts',
      note: `A real Vue 3 plugin: it injects the tag and gives you a typed track(). Route changes are tracked with no router wiring. If you would rather put the tag in index.html — which loads it fractionally earlier — the plugin detects it and will not add a second.`,
      code: [
        `// bun add ${PACKAGE_NAME}`,
        ``,
        `import { tsAnalytics } from '${PACKAGE_NAME}/vue'`,
        ``,
        `createApp(App)`,
        `  .use(tsAnalytics, {`,
        `    appId: '${id}',`,
        `    apiEndpoint: '${ORIGIN_TOKEN}',`,
        `  })`,
        `  .mount('#app')`,
      ].join('\n'),
    },
    {
      id: 'react',
      label: 'React',
      file: 'index.html',
      // No longer "same as Vue" — Vue has a plugin now and this does not, so the
      // tag in index.html is the whole integration here.
      note: 'Vite and CRA serve index.html as-is, so the tag belongs there rather than in a component — it should load once per document, not once per mount. For Next.js use the Next tab instead; it has its own script primitive.',
      code: [
        `<head>`,
        `  ${tag}`,
        `</head>`,
      ].join('\n'),
    },
    {
      id: 'next',
      label: 'Next.js',
      file: 'app/layout.tsx',
      note: 'next/script keeps the tag out of the hydration diff. afterInteractive loads it once navigation is live, which is early enough — the tracker records the first pageview itself.',
      code: [
        `import Script from 'next/script'`,
        ``,
        `export default function RootLayout({ children }) {`,
        `  return (`,
        `    <html>`,
        `      <body>`,
        `        {children}`,
        `        <Script`,
        `          src="${ORIGIN_TOKEN}/script.js"`,
        `          data-site="${id}"`,
        `          strategy="afterInteractive"`,
        `        />`,
        `      </body>`,
        `    </html>`,
        `  )`,
        `}`,
      ].join('\n'),
    },
    {
      id: 'svelte',
      label: 'SvelteKit',
      file: 'src/app.html',
      note: 'app.html wraps every route, so the tag loads once for the whole app.',
      code: [
        `<head>`,
        `  %sveltekit.head%`,
        `  ${tag}`,
        `</head>`,
      ].join('\n'),
    },
  ]
}

/**
 * Swap the tokens for real values. Called on the client, where the origin is
 * finally knowable.
 */
export function renderInstallCode(code: string, origin: string): string {
  return String(code ?? '')
    .split(ORIGIN_TOKEN)
    .join(normalizeOrigin(origin))
    .split(TAG_TOKEN)
    .join(`<${'scr'}${'ipt'}`)
    .split(ENDTAG_TOKEN)
    .join(`</${'scr'}${'ipt'}>`)
}
