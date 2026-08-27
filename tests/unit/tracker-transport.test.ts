/**
 * The tracker's transport choices.
 *
 * public/script.js is the artifact customers paste onto their sites, and it is
 * plain JavaScript with no build step and no tests around it. This file covers
 * the one property that broke in production: WHICH transport is used for which
 * origin.
 *
 * The failure was reported from easyotc.com's console:
 *
 *   Access to resource at 'https://analyticshq.org/collect' from origin
 *   'https://easyotc.com' has been blocked by CORS policy: Response to preflight
 *   request doesn't pass access control check: The value of the
 *   'Access-Control-Allow-Origin' header in the response must not be the
 *   wildcard '*' when the request's credentials mode is 'include'.
 *
 * Nothing in the tracker asks for credentials. `navigator.sendBeacon` is spec'd
 * to set the request's credentials mode to "include" on its own, and /collect
 * answers every origin with `*` by design — it is public and cannot keep an
 * allowlist of customer domains. The two are simply incompatible cross-origin.
 *
 * It failed silently, which is why it survived: sendBeacon returns true once the
 * request is QUEUED, not once it is delivered, so the guard took its early
 * return and the fetch fallback never ran. Core Web Vitals were dropped on every
 * install except our own same-origin dogfooding.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tracker = readFileSync(join(import.meta.dir, '../../public/script.js'), 'utf8')

/** The vitals flush — the only path that ever reached sendBeacon. */
function flushBlock(): string {
  const i = tracker.indexOf('sendBeacon')
  expect(i, 'the tracker no longer mentions sendBeacon at all').toBeGreaterThan(-1)
  const start = tracker.lastIndexOf('try {', i)
  const end = tracker.indexOf('catch', i)
  return tracker.slice(start, end)
}

describe('sendBeacon is never used cross-origin', () => {
  test('the call is gated on a same-origin check', () => {
    const block = flushBlock()
    expect(block).toContain('sameOrigin')
    // The gate has to be on the SAME expression as the call. Computing it and
    // then not using it is exactly the shape of the bug being fixed.
    expect(block).toMatch(/if\s*\(\s*sameOrigin\s*&&\s*navigator\.sendBeacon/)
  })

  test('the same-origin check compares against location.origin', () => {
    const block = flushBlock()
    expect(block).toMatch(/endpoint\.indexOf\(location\.origin/)
  })

  test('the fetch fallback is still reachable when the gate is false', () => {
    // The bug was an early `return` that skipped this line. It must sit AFTER
    // the guarded sendBeacon, unconditionally.
    const block = flushBlock()
    const beacon = block.indexOf('navigator.sendBeacon(')
    const fetchCall = block.indexOf('fetch(endpoint')
    expect(fetchCall).toBeGreaterThan(beacon)
    // Nothing may stand between them except the beacon's own early return.
    const between = block.slice(block.indexOf('return', beacon), fetchCall)
    expect(between).not.toContain('if (')
  })
})

describe('no send path asks for credentials', () => {
  // A credentialed request cannot be answered with the wildcard, and /collect
  // answers every origin with the wildcard. Any transport here that sets
  // credentials — explicitly, or by being sendBeacon cross-origin — is blocked
  // before it leaves the browser.
  test('no fetch sets credentials', () => {
    expect(tracker).not.toMatch(/credentials\s*:/)
  })

  test('every fetch to the collector is keepalive', () => {
    // keepalive is what survives the page going away, and unlike sendBeacon it
    // defaults to same-origin credentials mode, so the wildcard stays valid.
    const calls = [...tracker.matchAll(/fetch\(endpoint,\s*\{[^}]*\}/g)].map(m => m[0])
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls)
      expect({ call: call.slice(0, 48), keepalive: call.includes('keepalive') }).toEqual({ call: call.slice(0, 48), keepalive: true })
  })
})

describe('the beacon stays cheap', () => {
  // The tracker is loaded by every visitor to every customer site. It is the one
  // file in this repo where size is a feature.
  test('under 12KB uncompressed', () => {
    expect(tracker.length).toBeLessThan(12_000)
  })

  test('sends no document title or screen size', () => {
    // Removed in #10 and asserted here because they are the two fields a
    // well-meaning change would add back: a title routinely carries personal
    // data, and screen dimensions are a passive fingerprinting vector.
    //
    // Comments stripped first. send() carries a comment naming both fields and
    // explaining why they are absent, so matching the raw source fails on a
    // correct tracker — the assertion has to read code, not prose.
    const body = tracker
      .slice(tracker.indexOf('function send'), tracker.indexOf('w.analyticshq'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(body).not.toMatch(/\bt:\s*d\.title|document\.title/)
    expect(body).not.toMatch(/screen\.width|screen\.height|\bsw:\s|\bsh:\s/)
  })
})
