#!/usr/bin/env bun
/**
 * Fast local dev for this frontend-less stx app.
 *
 * `./buddy dev` advertises a Vue/Vite frontend that never binds for a pure-stx
 * app, then blocks the "ready" banner on a hardcoded 30s timeout
 * (readinessTimeoutMs in @stacksjs/buddy) — ~46s to boot, and the frontend URL
 * it prints refuses connections. See stacksjs/stacks#2036.
 *
 * This starts the three servers that actually matter, directly, in ~2s:
 *   - API / SSR pages      → :3008  (@stacksjs/actions dev/api.js)
 *   - Views + public assets → :3000 (@stacksjs/actions dev/views.js)
 *   - BunPress docs site    → :3006 (@stacksjs/actions dev/docs.js)
 *
 * Open http://localhost:3000 — the views server serves public assets and
 * proxies app/SSR routes to the API, so the whole styled site is there.
 *
 * The docs server is not optional: views.js unconditionally proxies /docs and
 * /docs/* to http://127.0.0.1:${ports.docs} (3006). Without it, every /docs URL
 * is a 500 "Unable to connect". It binds in ~1s and idles at ~80MB, so it is
 * cheap enough to always run.
 */
const env = { ...process.env, STACKS_DEV_SERVER: '1' }
const opts = { env, stdout: 'inherit', stderr: 'inherit' } as const

const api = Bun.spawn(['bun', 'node_modules/@stacksjs/actions/dist/dev/api.js'], opts)
const views = Bun.spawn(['bun', 'node_modules/@stacksjs/actions/dist/dev/views.js'], opts)
const docs = Bun.spawn(['bun', 'node_modules/@stacksjs/actions/dist/dev/docs.js'], opts)

console.log('\n  analyticshq dev\n    → http://localhost:3000   (full styled site: app + marketing)\n    → http://localhost:3000/docs   (docs, proxied from :3006)\n    → http://localhost:3008   (API only)\n')

function shutdown() {
  api.kill()
  views.kill()
  docs.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// If any server exits on its own, tear the others down too.
await Promise.race([api.exited, views.exited, docs.exited])
shutdown()
