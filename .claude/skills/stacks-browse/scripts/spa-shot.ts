#!/usr/bin/env bun
/**
 * Render-equivalence probe — does a page look the same when *navigated to* as
 * when loaded directly?
 *
 *   bun spa-shot.ts <from-url> <to-href> [--shots DIR] [--settle MS]
 *
 * This is the probe that catches the two classic stx SPA regressions, both of
 * which leave the URL and the markup correct while the page renders wrong:
 *
 *   1. head reconcile drops <link rel=stylesheet> → the destination renders
 *      unstyled after a swap but fine on reload.
 *   2. container attributes leak or vanish → a page whose layout lives on
 *      <main> (a centered auth form) loses its centering when swapped in, or
 *      leaves its classes behind on the next page.
 *
 * So it compares the *computed* result, not the HTML: <main>'s attributes, the
 * styles that actually resolved on it, and the stylesheet set. Markup equality
 * proves nothing here — in both bugs above the markup was already identical.
 */

import { mkdirSync } from 'node:fs'
import { Cdp, clickLink, goto, instrument, kill, launch, openPage, setViewport } from './cdp'

const [from, to, ...rest] = process.argv.slice(2)
if (!from || !to) {
  console.error('Usage: bun spa-shot.ts <from-url> <to-href> [--shots DIR] [--settle MS]')
  process.exit(1)
}

const flags = Object.fromEntries(
  rest.flatMap((a, i) => a.startsWith('--') ? [[a.slice(2), rest[i + 1]?.startsWith('--') === false ? rest[i + 1] : true]] : []),
) as Record<string, string | true>

const shotsDir = typeof flags.shots === 'string' ? flags.shots : null
const settle = typeof flags.settle === 'string' ? Number(flags.settle) : 1200
const origin = new URL(from).origin
const target = new URL(to, origin).href

/** Everything that decides whether the page *looks* right. */
const SIGNATURE = `(() => {
  const m = document.querySelector('main');
  const cs = m ? getComputedStyle(m) : null;
  const body = getComputedStyle(document.body);
  return {
    title: document.title,
    mainExists: !!m,
    mainAttrs: m ? Array.from(m.attributes).map(a => a.name + '=' + a.value).sort() : [],
    mainComputed: cs ? {
      display: cs.display, alignItems: cs.alignItems, justifyContent: cs.justifyContent,
      minHeight: cs.minHeight, maxWidth: cs.maxWidth, padding: cs.padding, margin: cs.margin,
    } : null,
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    fontFamily: body.fontFamily,
    stylesheets: Array.from(document.querySelectorAll('link[rel=stylesheet]'))
      .map(l => new URL(l.getAttribute('href'), location.origin).pathname).sort(),
    inlineStyleBlocks: document.querySelectorAll('style').length,
    // A stylesheet can be present but empty/404; count rules that actually loaded.
    cssRulesTotal: Array.from(document.styleSheets).reduce((n, s) => {
      try { return n + s.cssRules.length } catch { return n }
    }, 0),
    h1: (document.querySelector('h1')?.textContent || '').trim().slice(0, 60),
  };
})()`

function diff(a: any, b: any, path = ''): string[] {
  const out: string[] = []
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k
    const av = a?.[k]
    const bv = b?.[k]
    if (av && bv && typeof av === 'object' && typeof bv === 'object' && !Array.isArray(av)) {
      out.push(...diff(av, bv, p))
    }
    else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push(`${p}: direct=${JSON.stringify(av)} navigated=${JSON.stringify(bv)}`)
    }
  }
  return out
}

const session = await launch()
try {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true })
  const slug = new URL(target).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'

  // ── A: load the destination directly ──────────────────────────────────────
  const cdpA = await openPage(session.port)
  await instrument(cdpA)
  await setViewport(cdpA, 1280, 900)
  await goto(cdpA, target)
  const direct = await cdpA.eval(SIGNATURE)
  if (shotsDir) {
    const png = await cdpA.send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(`${shotsDir}/${slug}-direct.png`, Buffer.from(png.data, 'base64'))
  }
  cdpA.close()

  // ── B: reach the destination by clicking ──────────────────────────────────
  const cdpB = await openPage(session.port)
  const net = await instrument(cdpB)
  await setViewport(cdpB, 1280, 900)
  await goto(cdpB, from)
  net.reset()
  const found = await clickLink(cdpB, to, settle)
  if (!found) {
    console.log(JSON.stringify({ from, to, result: 'no-such-link', hint: `No <a href="${to}"> on ${from}` }, null, 2))
    cdpB.close()
    process.exit(2)
  }
  const navigated = await cdpB.eval(SIGNATURE)
  if (shotsDir) {
    const png = await cdpB.send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(`${shotsDir}/${slug}-navigated.png`, Buffer.from(png.data, 'base64'))
  }
  const hardReload = net.documents().filter(d => !d.url.startsWith('data:')).length > 0
  cdpB.close()

  const deltas = diff(direct, navigated)
  console.log(JSON.stringify({
    from,
    to,
    // A hard reload makes the comparison trivially pass — it is the same code
    // path twice. Say so, or a green result reads as proof the router works.
    routedAsSpa: !hardReload,
    identical: deltas.length === 0,
    differences: deltas,
    direct,
    navigated,
    consoleErrors: net.consoleErrors,
    ...(shotsDir ? { shots: [`${shotsDir}/${slug}-direct.png`, `${shotsDir}/${slug}-navigated.png`] } : {}),
  }, null, 2))
  process.exit(deltas.length ? 1 : 0)
}
finally {
  kill(session)
}
