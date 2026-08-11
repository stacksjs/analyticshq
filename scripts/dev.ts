#!/usr/bin/env bun
/**
 * Fast local dev for this frontend-less stx app.
 *
 * `./buddy dev` advertises a Vue/Vite frontend that never binds for a pure-stx
 * app, then blocks the "ready" banner on a hardcoded 30s timeout
 * (readinessTimeoutMs in @stacksjs/buddy) — ~46s to boot, and the frontend URL
 * it prints refuses connections. See stacksjs/stacks#2036.
 *
 * This starts the two servers that actually matter, directly, in ~2s:
 *   - API / SSR pages       → :3008 (@stacksjs/actions dev/api.js)
 *   - Views + public assets → :3000 (@stacksjs/actions dev/views.js)
 *
 * Open http://localhost:3000 — the views server serves public assets and
 * proxies app/SSR routes to the API, so the whole styled site is there.
 *
 * A third server used to run here: the BunPress docs site on :3006, described as
 * "not optional" because views.js was said to proxy /docs to it unconditionally.
 * It is conditional, and the condition is false for this app:
 *
 *   const hasUserDocsView = ['docs.stx', 'docs/index.stx'].some(...)
 *   const docsProxyEnabled = !hasUserDocsView && hasDocsSite
 *
 * We ship resources/views/docs.stx, so the proxy has been disabled and every
 * /docs request has been answered by stx — the same page production serves.
 * The docs server was binding a port, idling at ~80MB and receiving nothing.
 */
const env = { ...process.env, STACKS_DEV_SERVER: '1' }
const opts = { env, stdout: 'inherit', stderr: 'inherit' } as const

const api = Bun.spawn(['bun', 'node_modules/@stacksjs/actions/dist/dev/api.js'], opts)
const views = Bun.spawn(['bun', 'node_modules/@stacksjs/actions/dist/dev/views.js'], opts)

console.log('\n  analyticshq dev\n    → http://localhost:3000   (full styled site: app + marketing + docs)\n    → http://localhost:3008   (API only)\n')

function shutdown() {
  api.kill()
  views.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// If either server exits on its own, tear the other down too.
await Promise.race([api.exited, views.exited])
shutdown()
