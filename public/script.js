/**
 * analyticshq tracker.
 *
 * Served as a STATIC asset from `public/`, not rendered by a route. The views
 * server (`buddy serve`) only forwards `/api/*` and mutating methods to the
 * bun-router backend, so a `GET /script.js` route on that backend is
 * unreachable from the public origin — this file is what the snippet actually
 * loads.
 *
 * Being static also means the collect origin cannot be baked in server-side,
 * which is an improvement rather than a compromise: it is derived from this
 * script's own URL, so the same asset works unmodified when it is served from
 * the apex, from the legacy domain, from a customer's CNAME, or from localhost
 * in development — and it beacons back to whichever host served it.
 *
 * Embed with:
 *   <script defer src="https://analyticshq.org/script.js" data-site="SITE_ID"></script>
 */
(function () {
  const d = document
  const w = window
  // `currentScript` is only non-null while this file is executing, so both the
  // site id and the origin must be read here — not inside `send`, which runs
  // later from event handlers and history hooks.
  const s = d.currentScript
  const site = s && s.getAttribute('data-site')
  if (!site) return

  // Do Not Track / Global Privacy Control (#8).
  //
  // Checked once, here, rather than inside `send`: `currentScript` is only
  // readable during this pass anyway, and bailing now means no listeners are
  // attached and no history hooks installed — the tracker leaves no trace at
  // all rather than merely declining to transmit.
  //
  // Respected by DEFAULT, which is a deliberate position: we already store no
  // personal data, so honoring the signal costs us nothing and is the one thing
  // a visitor can actively say. Opt out per site with data-respect-dnt="false"
  // if you would rather count those visits.
  //
  // `navigator.doNotTrack` is the string "1"; some older builds put it on
  // `window` or spell it `msDoNotTrack`. GPC is a real boolean.
  if (s.getAttribute('data-respect-dnt') !== 'false') {
    const n = navigator
    const dnt = n.doNotTrack || w.doNotTrack || n.msDoNotTrack
    if (dnt === '1' || dnt === 'yes' || n.globalPrivacyControl === true) return
  }

  let endpoint
  try {
    endpoint = new URL(s.src, location.href).origin + '/collect'
  }
  catch (_) {
    return
  }

  // No cookies or device storage: the server derives sessions from the anonymous
  // visitor hash + a 30-min window, keeping the tracker consent-free.
  function send(e, p) {
    try {
      const q = new URLSearchParams(location.search)
      const b = {
        s: site,
        e: e,
        p: p || {},
        u: location.origin + location.pathname,
        r: d.referrer || '',
      }
      // Deliberately NOT sent (#10):
      //   t  — document.title. A title routinely carries page content, and on a
      //        real app that means personal data: "Invoice #4432 — Jane Smith",
      //        "Reset password for alice@example.com". The path already
      //        identifies the page for every report we have.
      //   sw/sh — screen.width/height. A classic passive fingerprinting vector,
      //        and device_type is derived from the User-Agent, not from these.
      // All three were write-only: stored on every page view and read by nothing.
      // Reinstate only behind a per-site opt-in, never by default.
      ;['source', 'medium', 'campaign', 'content', 'term'].forEach((k) => {
        const v = q.get('utm_' + k)
        if (v) b['utm_' + k] = v
      })
      fetch(endpoint, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      })
    }
    catch (_) {}
  }

  w.analyticshq = function (name, props) { send(name, props) }

  // Core Web Vitals (#41).
  //
  // ONE beacon per page, not one per metric. LCP, CLS and INP are not final
  // until the page is hidden — LCP can be superseded by a later paint, CLS
  // accumulates, INP is a running maximum — so there is nothing to gain by
  // reporting them early and a 5x ingest bill for doing it. Everything is
  // buffered and flushed once, at the moment the values stop changing.
  //
  // Opt out per site with data-vitals="false", alongside data-respect-dnt.
  //
  // Privacy: these are timings the browser already computed to render the page.
  // No new identifier is read, nothing is stored on the device, and the server
  // keeps only the number and the path — which is why this is compatible with
  // the no-consent-banner claim in a way that, say, a heatmap would not be.
  if (s.getAttribute('data-vitals') !== 'false' && w.PerformanceObserver) {
    const vitals = {}
    // The path AT LOAD. CLS and INP accumulate over the document's whole
    // lifetime, which on an SPA spans several routes, and the standard
    // web-vitals library attributes the total to the initial page for exactly
    // that reason: the document is what was measured.
    const vpath = location.pathname
    let cls = 0
    let inp = 0
    let flushed = false

    function obs(type, fn, extra) {
      try {
        const o = { type: type, buffered: true }
        if (extra) o.durationThreshold = extra
        new PerformanceObserver(fn).observe(o)
      }
      // An unsupported entry type throws here rather than failing silently, and
      // browser support genuinely differs (no INP in Safari before 16.4). One
      // missing metric must not take the other four with it.
      catch (_) {}
    }

    obs('largest-contentful-paint', function (l) {
      const e = l.getEntries()
      if (e.length) vitals.LCP = e[e.length - 1].startTime
    })
    obs('paint', function (l) {
      l.getEntries().forEach(function (e) {
        if (e.name === 'first-contentful-paint') vitals.FCP = e.startTime
      })
    })
    obs('layout-shift', function (l) {
      // Shifts the visitor caused by interacting are excluded by definition —
      // a layout change right after a tap is a response, not instability.
      l.getEntries().forEach(function (e) { if (!e.hadRecentInput) cls += e.value })
    })
    obs('event', function (l) {
      l.getEntries().forEach(function (e) {
        if (e.interactionId && e.duration > inp) inp = e.duration
      })
    }, 16)

    function flush() {
      if (flushed) return
      flushed = true
      // CLS travels as the real ratio (0.0834), not scaled to an integer. The
      // column is a float, so nothing has to unscale it at read time.
      if (cls > 0) vitals.CLS = cls
      if (inp > 0) vitals.INP = inp
      try {
        const nav = performance.getEntriesByType('navigation')[0]
        if (nav && nav.responseStart > 0) vitals.TTFB = nav.responseStart
      }
      catch (_) {}
      if (!Object.keys(vitals).length) return
      const body = JSON.stringify({
        s: site,
        e: 'vitals',
        p: vitals,
        u: location.origin + vpath,
        r: '',
      })
      try {
        // sendBeacon ONLY when the collector is same-origin.
        //
        // sendBeacon is spec'd to set the request's credentials mode to
        // "include", and a credentialed request cannot be answered with
        // `Access-Control-Allow-Origin: *`. /collect answers every origin with
        // the wildcard, deliberately — it is a public endpoint that must accept
        // beacons from any customer domain without an allowlist — so every
        // cross-origin sendBeacon here was refused by the browser before it left:
        //
        //   Access to resource at 'https://analyticshq.org/collect' from origin
        //   'https://easyotc.com' has been blocked by CORS policy: … must not be
        //   the wildcard '*' when the request's credentials mode is 'include'.
        //
        // It failed silently. sendBeacon returns true once the request is
        // QUEUED, not once it is delivered, so the `return` below was taken and
        // the fetch fallback never ran. Core Web Vitals — the only payload that
        // goes through this path — were lost on every cross-origin install,
        // which is every install except our own dogfooding.
        //
        // The fix is not to relax CORS. Echoing the origin with
        // Allow-Credentials would make sendBeacon work and would also start
        // sending cookies to the collector on every beacon, on a product whose
        // entire pitch is that it sets none.
        //
        // fetch(keepalive) has no such problem: default credentials mode is
        // same-origin, so the wildcard is valid, and the browser still delivers
        // it after the page goes away. Its 64KB cap is irrelevant here — this
        // body is a handful of numbers.
        const sameOrigin = endpoint.indexOf(location.origin + '/') === 0
        if (sameOrigin && navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }))) return
        fetch(endpoint, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body })
      }
      catch (_) {}
    }

    // visibilitychange is the reliable end-of-page signal; pagehide covers the
    // Safari/bfcache cases where it does not fire. `flushed` makes the overlap
    // harmless — whichever arrives first wins and the other is a no-op.
    d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') flush() })
    w.addEventListener('pagehide', flush)
  }

  const DLRE = /\.(pdf|zip|dmg|exe|csv|xlsx?|docx?|pptx?|mp3|mp4|pkg|rar|gz|tar|wav|avi|mov|mkv|txt|svg)$/i
  function onLink(ev) {
    if (ev.type === 'auxclick' && ev.button !== 1) return
    try {
      const t = ev.target
      const a = t && t.closest ? t.closest('a') : null
      if (!a) return
      const href = a.getAttribute('href')
      if (!href) return
      if (/^(javascript:|mailto:|tel:)/i.test(href)) return
      const url = new URL(a.href, location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      const cross = url.hostname !== location.hostname
      const path = url.pathname
      if ((a.hasAttribute('download') && !cross) || DLRE.test(path)) {
        send('File Download', { url: a.href })
        return
      }
      if (cross) send('Outbound Link', { url: a.href })
    }
    catch (_) {}
  }
  d.addEventListener('click', onLink, true)
  d.addEventListener('auxclick', onLink, true)

  function pv() { send('pageview') }
  pv()
  const push = history.pushState
  history.pushState = function () { push.apply(this, arguments); pv() }
  w.addEventListener('popstate', pv)
})()
