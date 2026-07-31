#!/usr/bin/env bun
/**
 * SPA navigation probe — did clicking this link route, or hard-reload?
 *
 *   bun spa-probe.ts <from-url> <to-href> [--expect spa|reload] [--settle MS]
 *
 * How it decides. The stx router intercepts a click and fetches the destination
 * as a fragment (an XHR/Fetch request carrying `X-STX-Router`). A browser doing a
 * real navigation issues a **Document**-type request instead. So: a Document
 * request after the click means SPA routing did not happen.
 *
 * Exit code is 0 only when the observed mode matches `--expect`, so this is
 * usable as a control: point it at a page you know cannot route (no <main>) and
 * it must report `reload`. A probe that says `spa` either way measures nothing.
 */

import { Cdp, clickLink, goto, instrument, kill, launch, openPage } from './cdp'

const [from, to, ...rest] = process.argv.slice(2)
if (!from || !to) {
  console.error('Usage: bun spa-probe.ts <from-url> <to-href> [--expect spa|reload] [--settle MS]')
  process.exit(1)
}

const flags = Object.fromEntries(
  rest.flatMap((a, i) => a.startsWith('--') ? [[a.slice(2), rest[i + 1]?.startsWith('--') === false ? rest[i + 1] : true]] : []),
) as Record<string, string | true>

const expect = typeof flags.expect === 'string' ? flags.expect : null
const settle = typeof flags.settle === 'string' ? Number(flags.settle) : 1200

const session = await launch()
try {
  const cdp = await openPage(session.port)
  const net = await instrument(cdp)

  await goto(cdp, from)
  const before = await cdp.eval<string>('location.pathname')

  // Only requests caused by the click are evidence. Everything the initial page
  // load issued is noise, so drop it here rather than trying to filter later.
  net.reset()

  const found = await clickLink(cdp, to, settle)
  if (!found) {
    // A missing link is not a routing failure. Reporting it as one sends you
    // hunting through the router for a bug that lives in the template.
    console.log(JSON.stringify({ from, to, result: 'no-such-link', hint: `No <a href="${to}"> on ${from}` }, null, 2))
    cdp.close()
    process.exit(2)
  }

  const after = await cdp.eval<string>('location.pathname')
  const docs = net.documents().filter(d => !d.url.startsWith('data:'))
  const mode = docs.length ? 'reload' : 'spa'

  const out = {
    from,
    to,
    navigated: before !== after,
    pathname: { before, after },
    mode,
    documentRequests: docs.map(d => `${d.status ?? '?'} ${d.url}`),
    fragmentRequests: net.requests
      .filter(r => r.type === 'Fetch' || r.type === 'XHR')
      .map(r => `${r.status ?? '?'} ${r.url}`),
    consoleErrors: net.consoleErrors,
    ...(expect ? { expected: expect, pass: mode === expect } : {}),
  }
  console.log(JSON.stringify(out, null, 2))
  cdp.close()
  process.exit(expect && mode !== expect ? 1 : 0)
}
finally {
  kill(session)
}
