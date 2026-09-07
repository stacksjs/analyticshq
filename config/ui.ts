import type { StxOptions as UiOptions } from '@stacksjs/stx'

/**
 * stx / UI topology for analyticshq.
 *
 * Verified against the INSTALLED @stacksjs/stx 0.2.146 + bun-plugin-stx 0.2.146.
 * Every file:line below was checked on the installed dist, not on documentation.
 *
 * THIS FILE IS READ BY TWO LOADERS THAT DO NOT AGREE:
 *   Loader A — @stacksjs/stx loadStxConfig()  → post-processes the object: applies
 *              resolveStxRoot (config.js:363-374) and then prefixes componentsDir /
 *              layoutsDir / partialsDir with `root` a SECOND time (config.js:411-419).
 *              Used by stx build, the SSG, store-loader, composable-loader, crosswind.
 *   Loader B — bun-plugin-stx serve()         → reads this file RAW via its own bundled
 *              bunfig and uses these literal strings as the fallback at
 *              serve.js:8973-8975 (`options.X ?? stxConfig.X ?? defaultStxConfig.X`).
 *              It never calls resolveStxRoot. Used on every dev/prod request.
 *
 * Because Loader A prefixes and Loader B does not, a relative directory value can only
 * be correct in both when `root` is '.'. That is why root is pinned below and every path
 * is written project-root-relative. Before this was pinned, root was INFERRED as
 * 'resources' from the mere existence of resources/layouts (config.js:367-369) and all
 * three template dirs resolved to 'resources/resources/*', none of which exist —
 * which is why 54 @include('site-nav'|'site-footer') calls failed during the static
 * build and 27 files in dist/ shipped ANSI-coloured `include error:` banners as page
 * content. Verify with scripts/check-stx-topology.ts.
 *
 * StxOptions = Partial<StxConfig> (types/config-types.d.ts:394). Key declarations:
 * root :260, pagesDir :262, componentsDir :273, layoutsDir :275, storesDir :276,
 * composablesDir :277, publicDir :280, strict :311.
 */
export default {
  // Pinned so resolveStxRoot returns immediately (config.js:365-366) instead of sniffing
  // the filesystem (config.js:367-369). '.' also fails the `root !== '.'` guard at
  // config.js:411, which is what disables the double-prefix. Note the sniff reads
  // process.cwd(), NOT the cwd passed to loadStxConfig — so it was never reliable.
  root: '.',

  // Dev/prod-INERT: routing comes from serve()'s `patterns` (fed by
  // @stacksjs/actions/dist/dev/views.js:59 and @stacksjs/buddy production-server.js:114);
  // `stxConfig.pagesDir` is not read by serve.js. Declared for the build/SSG path, where
  // build.js:10 computes path.join(config.root || '.', config.pagesDir || ...). Without it,
  // root:'.' would make Loader A report 'pages' — a directory this app does not have.
  pagesDir: 'resources/views',

  // Render-inert on the live paths (views.js:71 and production-server.js:121 both pass an
  // explicit componentsDir, and options wins at serve.js:8973). Declared because it is
  // Loader B's fallback and the value every non-serve entry point sees.
  componentsDir: 'resources/components',

  // Makes the 45 @stacksjs/components tags (<Skeleton>, <Table>, <Avatar>, …)
  // resolvable by name, so the app stops hand-rolling widgets the library ships.
  //
  // This key survives the loader split that the header documents, and it is worth
  // saying why, because the componentsDir immediately above does NOT:
  //   - componentsDir is overridden by the explicit option views.js passes, so the
  //     value here never reaches a live render.
  //   - plugins are read on a different path. serve.js:9016-9021 calls stx's own
  //     loadStxConfig() with NO cwd and copies `_pluginComponentDirs` off the
  //     result, so it is additive to the options-supplied componentsDir rather than
  //     in competition with it. Both dirs end up on the resolver's search frontier.
  //
  // loadStxConfig() finds THIS file because it loads with `{ name: 'stx', alias:
  // 'ui' }` (config.js:445-446) — the alias is what makes config/ui.ts the stx
  // config in a Stacks app, and it is why the router block documented at the bottom
  // of this file is the exception rather than the rule.
  //
  // The plugin declares a RELATIVE `components: './src/ui'`, resolved against the
  // plugin's own directory via `path.dirname(require.resolve(pluginPath))`
  // (config.js:462, :473) — so it lands in node_modules/@stacksjs/components,
  // not in this project. Component resolution walks subdirectories, so the
  // library's grouped `src/ui/<name>/<Name>.stx` layout resolves as-is.
  plugins: ['@stacksjs/components/stx-plugin'],

  // MUST stay outside pagesDir. Route discovery and the SSG have no exclusion for layout
  // directories, so a layout under resources/views/ is a public URL that gets built to
  // HTML and listed in the sitemap. resources/views/layouts/ is deleted for that reason;
  // with it gone both live selectors agree with this value — dev's
  // firstExistingPath(['resources/views/layouts','resources/layouts']) (views.js:59-62,
  // :115-123) returns resources/layouts, and prod's existsSync ternary
  // (production-server.js:114) falls through to the same. Empty today; the layouts stage
  // fills it. NOTE views.js:120 prefers whichever candidate actually contains a .stx, so
  // resurrecting resources/views/layouts later would silently win in dev only.
  layoutsDir: 'resources/layouts',

  // The only partials candidate that contains templates (site-nav.stx, site-footer.stx),
  // so both loaders already select it — only the double-prefix made this key a lie.
  partialsDir: 'resources/partials',

  // LIVE on every top-level render, and the reason `root` is not merely cosmetic:
  // storesDir is absent from serve()'s allowlist, so store-loader.js:5-11 falls to
  // `path.resolve(config.root || process.cwd(), config.storesDir || 'stores')` off
  // Loader A. Under root:'.' the bare default would move discovery to <app>/stores;
  // this value keeps it at <app>/resources/stores. Empty for now: with no *.ts inside,
  // getStoreScript returns null and no bundle is injected.
  // Caveat for the state stage: that null is memoised (store-loader.js:12+) and nothing
  // calls clearStoreCache(), so the FIRST store file needs a dev-server restart.
  storesDir: 'resources/stores',

  // Same mechanism — read from Loader A at render time and resolved against `root`
  // (composable-loader.js probeDefaultDirs). Pinned because root:'.' would otherwise
  // change where stx probes: the default candidates are ['composables','functions']
  // resolved against root, and resources/functions is where Stacks' `buddy make:function`
  // writes. Inert today (the directory is empty, so the loader returns null either way).
  composablesDir: 'resources/functions',

  // The one directory key the dev server actually honours: neither views.js nor
  // production-server.js passes publicDir, so serve.js:8976 falls through to this value.
  // 'public' equals the default it replaces, so declaring it is a zero-delta truth claim.
  publicDir: 'public',

  // stx's client-script DOM guard (25 rules, script-validation.js:1-127). serve.js
  // forwards it ONLY when the key is literally present — `..."strict" in stxConfig`
  // at :9567 and :9745 — so without this key every violation is collected and silently
  // discarded (script-validation.js:148). Warn-only: rendered HTML is untouched.
  //
  // failOnViolation MUST stay false. The throw at script-validation.js:154 is a plain
  // Error that processDirectives catches and replaces the ENTIRE page with
  // `<!-- Template Processing failed: ... -->` served at HTTP 200 — a blank page, not a 500.
  //
  // allowPatterns is deliberately absent: it is a rule-GLOBAL substring filter matched
  // against the message OR the regex source (script-validation.js:131), so exempting
  // 'location.replace()' for the pre-paint auth guards would also silence every other
  // location rule across the app.
  //
  // Gated to non-production because there is no render cache on either server, so
  // validateClientScript re-runs per request (process.js:782) with no memoisation —
  // measured at ~2 warning blocks per GET / and 6 per full 32-route sweep. That is
  // useful in dev and pure stderr noise in prod.
  //
  // This flag is NOT the enforcement gate: signal-using <script client> blocks are
  // re-tagged data-stx-scoped by processScriptSetup and then skipped by process.js's
  // skipAttrs, so it sees only 2 of the app's 7 violating blocks. The standalone
  // scanner in the enforcement stage is the real gate.
  strict: {
    enabled: process.env.APP_ENV !== 'production',
    failOnViolation: false,

    // The two DOM calls that are deliberate. allowPatterns matches a rule's
    // `message` or its `pattern.source` (script-validation.js:131), so each entry
    // suppresses exactly one rule — stx-standards §12.1.
    allowPatterns: [
      // CSV export builds an <a download> and clicks it. There is no stx
      // primitive for this: the package exports nothing matching
      // download/saveAs/blob/useFile, checked against 0.2.171. Revisit if one
      // ever ships.
      'document.createElement',
      // Blob-URL revoke after the CSV download. useTimeout() cancels itself on
      // destroy, which is right for a UI flag and actively wrong here —
      // navigating within the second would cancel the revoke, and because an SPA
      // swap keeps the document alive the blob URL would leak for the rest of the
      // session. Cleanup must not be cancellable by navigation. Reasoning is
      // inline at the call site in dashboard.stx.
      'setTimeout',
    ],
  },

  /**
   * The document head every page shares. Reaches BOTH page shapes:
   *   - fragments (login, register, account, dashboard, sites/new) via
   *     generateDocumentShell, which renders `link` into <head>;
   *   - the 27 marketing pages, which own a <!DOCTYPE> and so are topped up by
   *     injectConfigHeadTags instead — it skips any <link> whose exact href is
   *     already in the head, so config and per-page copies cannot double.
   *
   * ONLY genuinely universal tags belong here. Deliberately NOT centralized:
   *
   *   charset / viewport — generateDocumentShell PREPENDS its own hardcoded pair
   *     (document-shell.js:91-92) and then spreads config `meta` with no dedup,
   *     unlike injectConfigHeadTags which dedups by name (:143). Declaring them
   *     here yields TWO of each on every fragment page — measured. The marketing
   *     pages keep their own until the layouts stage removes their <head>
   *     entirely, at which point the shell supplies both for free.
   *
   *   /marketing.css — present on exactly the 27 marketing pages and deliberately
   *     absent from the 5 app/auth pages. `app.head` is global, so putting it here
   *     would push marketing CSS onto the app shell. It belongs in the marketing
   *     layout's @head block (layouts stage).
   *
   *   theme-color — stx already injects a media-scoped light/dark pair
   *     (data-stx-theme-meta="1"); the app's un-scoped #0a0c0e is a third tag that
   *     competes with them. Reconciling that is a fix, not a move.
   *
   *   title — injectConfigHeadTags never writes <title>, so a config title would
   *     reach fragments only. The 6 features/* pages that render stx's
   *     "stx Project" placeholder need real titles (SEO stage); `skipDefaultSeoTags`
   *     must NOT be set before then or they end up with no <title> at all.
   */
  /**
   * NO `router` KEY HERE, AND THAT IS DELIBERATE -- it would be silently inert.
   *
   * The app serves interceptAllLinks:true, so the router intercepts every
   * same-origin anchor that lacks data-no-router. Turning that off from this file
   * does not work, and fails without a warning: serve.ts getRouterInjectOptions()
   * merges `{ interceptAllLinks: true, container: 'main' }` with
   * `siteConfig.router` and `stxConfig.router`, and its `stxConfig` is bunfig's own
   * lookup for a ROOT stx.config.ts. This app has none -- Stacks keeps config in
   * config/ -- so that spread is empty and the hardcoded true always wins. Setting
   * `router: { interceptAllLinks: false }` here changed nothing; measured, not
   * assumed.
   *
   * Everything else in this file DOES reach stx, because Stacks' views.js passes it
   * as explicit options (Loader A). The router block is the one that needs the file
   * bunfig looks for, and adding a root stx.config.ts to get it would create a
   * second source of truth for exactly the directory keys documented above as
   * loader-sensitive. Not worth it for one flag.
   *
   * The concrete reason anyone would want it off is handled at the call site
   * instead: see the data-no-router on the OAuth anchors in login.stx/register.stx.
   */
  app: {
    /**
     * Pre-paint theme bootstrap.
     *
     * resources/layouts/app.stx has carried a full light AND dark palette from
     * the start — `:root` light, a prefers-color-scheme dark block, and
     * `[data-theme]` overrides for both. So the app already followed the OS
     * setting; what it never had was a way to override it, because nothing
     * wrote that attribute.
     *
     * This declaration is what makes the override flash-free. `useColorMode`
     * runs inside the signals runtime, after hydration begins, which is far too
     * late — every cold load would paint the OS theme and then snap to the
     * stored preference. stx emits a render-blocking snippet from these same
     * options and puts it above the stylesheet, so the root element is correct
     * before the first paint.
     *
     * The values MUST match resources/stores/theme.ts exactly. If the boot
     * script and useColorMode disagree on either the key or the attribute, the
     * flash returns and the toggle appears to do nothing on reload.
     *
     * `darkClass` alongside `attribute`, not instead of it: our own tokens key
     * off [data-theme], but crosswind's darkMode defaults to the class strategy,
     * so every `dark:` utility in @stacksjs/components compiles to `.dark .…`
     * and would never match without it.
     */
    colorMode: {
      storageKey: 'analyticshq_theme',
      attribute: 'data-theme',
      darkClass: 'dark',
      initialMode: 'auto',
    },

    head: {
      // Present on all 32 views today, which is why the fonts live here and not in
      // public/marketing.css — the 5 app/auth pages do not load that file.
      //
      // These three entries used to be two preconnects and a stylesheet pointing at
      // fonts.googleapis.com. That sent every visitor's IP, User-Agent and Referer
      // to Google on every page, /login included, which contradicted the claim
      // /compare/google-analytics makes to the reader's face — that GA hands data to
      // Google while ours goes "into your own PostgreSQL database, and nowhere
      // else" — and is the exact arrangement LG München I found unlawful under GDPR
      // in 2022. Self-hosting removes the request rather than making it cheaper.
      //
      // The two preconnects went with it: preconnecting to a host we no longer use
      // is a DNS + TLS handshake for nothing, and it would still leak the visit.
      link: [
        { rel: 'preload', href: '/assets/fonts/geist/geist-latin.woff2', as: 'font', type: 'font/woff2', crossorigin: '' },
        { rel: 'stylesheet', href: '/fonts.css' },
      ],

      /**
       * The coming-soon gate. These three were <body> attributes hand-written in
       * index.stx, which is the only reason that page kept its own <!DOCTYPE> and
       * stayed off the marketing layout -- a page that writes its own document
       * shell cannot receive body attributes from anywhere else.
       *
       * They are read by resources/assets/scripts/site-mode.js (via body.dataset)
       * and by four rules in public/marketing.css that key off
       * body[data-site-mode="coming-soon"]. Values are strings because they are
       * DOM attributes: site-mode.js compares bypassEnabled to the STRING 'true'.
       *
       * Global rather than marketing-only, and that is safe in both directions:
       * the CSS only reacts to data-site-mode="coming-soon", and the elements it
       * hides (.site-content / .mode-screen) exist solely in the marketing layout,
       * so the 5 app/auth pages carry inert attributes and render unchanged.
       *
       * Currently 'live', so the whole gate is dormant -- flipping this single
       * value to 'coming-soon' is what arms it.
       */
      bodyAttrs: {
        'data-site-mode': 'live',
        'data-coming-soon-bypass-enabled': 'true',
        'data-coming-soon-bypass': 'trailhead',
      },
    },
  },

  /**
   * We measure this site with the product it sells (#12).
   *
   * Before this, config/analytics.ts declared `driver: 'fathom'` with a real Fathom
   * site id — a competitor's tracker, configured on the site whose /compare pages
   * argue against handing visitors to third parties. It never actually loaded (no
   * code reads that file), so the effect was not a leak but something almost as bad:
   * a config that read like a decision nobody had taken, on a product that collected
   * nothing about itself while selling analytics.
   *
   * `driver: 'custom'` rather than stx's own `'self-hosted'`. That driver exists and
   * would work, but it generates its OWN inline beacon with its own payload shape
   * (a random session id, `t('outbound', ...)`) posted to `apiEndpoint`. Our
   * /collect contract is different, and more to the point, dogfooding means running
   * the artifact we hand customers — public/script.js, loaded exactly the way the
   * install snippet on the homepage tells them to load it. Anything else measures a
   * tracker no customer runs.
   *
   * Injection is stx's, not ours: process.js calls injectAnalytics(), which places
   * the tag before </head> on every page. Global is deliberate and safe here — every
   * app route is a fixed path (/login, /dashboard, /account, /sites/new; there are no
   * [param] routes), and the tracker sends `location.origin + location.pathname`, so
   * query strings are dropped and no customer site id can reach a recorded path.
   *
   * Off unless ANALYTICSHQ_SITE_ID is set, which keeps development and any fresh
   * checkout from beaconing at production. `enabled: false` makes
   * generateAnalyticsScript return '' before it reads anything else.
   *
   * The site id is not a secret — it ships in the snippet on every customer's site,
   * which is exactly why tests/unit/api-authz.test.ts gates every site-scoped read on
   * ownership instead of on knowing the id.
   */
  analytics: {
    enabled: !!process.env.ANALYTICSHQ_SITE_ID,
    driver: 'custom',
    custom: {
      scriptUrl: '/script.js',
      // No `defer` here: generateCustomScript appends one unconditionally, and
      // declaring it too renders `<script defer="" ... defer>`.
      attributes: {
        'data-site': process.env.ANALYTICSHQ_SITE_ID || '',
      },
    },
  },
} satisfies UiOptions
