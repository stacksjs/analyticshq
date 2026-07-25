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
  var d = document
  var w = window
  // `currentScript` is only non-null while this file is executing, so both the
  // site id and the origin must be read here — not inside `send`, which runs
  // later from event handlers and history hooks.
  var s = d.currentScript
  var site = s && s.getAttribute('data-site')
  if (!site) return

  var endpoint
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
      var q = new URLSearchParams(location.search)
      var b = {
        s: site,
        e: e,
        p: p || {},
        u: location.origin + location.pathname,
        r: d.referrer || '',
        t: d.title,
        sw: screen.width,
        sh: screen.height,
      }
      ;['source', 'medium', 'campaign', 'content', 'term'].forEach(function (k) {
        var v = q.get('utm_' + k)
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

  var DLRE = /\.(pdf|zip|dmg|exe|csv|xlsx?|docx?|pptx?|mp3|mp4|pkg|rar|gz|tar|wav|avi|mov|mkv|txt|svg)$/i
  function onLink(ev) {
    if (ev.type === 'auxclick' && ev.button !== 1) return
    try {
      var t = ev.target
      var a = t && t.closest ? t.closest('a') : null
      if (!a) return
      var href = a.getAttribute('href')
      if (!href) return
      if (/^(javascript:|mailto:|tel:)/i.test(href)) return
      var url = new URL(a.href, location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      var cross = url.hostname !== location.hostname
      var path = url.pathname
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
  var push = history.pushState
  history.pushState = function () { push.apply(this, arguments); pv() }
  w.addEventListener('popstate', pv)
})()
