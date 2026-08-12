/**
 * Traffic alerts (#24).
 *
 * Two halves, split by what a test can honestly prove.
 *
 * The decision logic and the address table are pure, so they are tested exactly
 * and exhaustively here. The database half — metric counts, the median baseline
 * over real rows, the FK cascade — is exercised against a real Postgres instead,
 * because mocking a query only proves the mock.
 *
 * DNS is deliberately absent from this file. `checkWebhookUrl` resolves
 * hostnames, and a suite that fails on a train is a suite people learn to skip.
 * Address literals short-circuit before the resolver, so those are covered here;
 * the resolving path is covered by a probe that points a real public hostname
 * (`localtest.me`, whose A record is 127.0.0.1) at the guard.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  baselineWindows,
  changePercent,
  evaluate,
  inCooldown,
  isAlertCondition,
  isAlertMetric,
  isRelative,
  median,
  observationWindow,
} from '../../app/Analytics/alerts'
import { parseChannels, webhookPayload } from '../../app/Alerts/delivery'
import { checkUrlShape, isBlockedAddress } from '../../app/Alerts/url-safety'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with comments removed — the same helper, and the same reason, as
 * tests/unit/no-third-party-assets.test.ts.
 *
 * These files explain their own load-bearing lines in prose directly above them,
 * so a check against the raw text matches the explanation and passes whether or
 * not the code still says it. Verified: flipping `redirect: 'error'` to `'follow'`
 * left the test green, because the header comment still contained the string.
 * Match code, not prose.
 */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** A minimal alert; each test overrides only the fields it is about. */
const base = { condition: 'spike', threshold: 50, min_volume: 20 }

describe('the baseline summary', () => {
  test('is a median, so one freak day cannot hide a real change', () => {
    // The point of the choice: a launch day in the sample would drag a mean to 23
    // and swallow the next week's movement behind it.
    const week = [10, 10, 10, 100, 10, 10, 10]
    expect(median(week)).toBe(10)
    expect(Math.round(week.reduce((a, b) => a + b) / week.length)).toBe(23)
  })

  test('averages the two middles for an even sample', () => {
    expect(median([10, 20])).toBe(15)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  test('an empty history is nothing, not a crash', () => {
    expect(median([])).toBe(0)
  })

  test('change against no baseline is null, not zero or infinity', () => {
    // Null keeps "no history" distinguishable from "flat". A template that
    // renders them the same tells the reader something untrue.
    expect(changePercent(50, 0)).toBeNull()
    expect(changePercent(30, 10)).toBe(200)
    expect(changePercent(5, 10)).toBe(-50)
  })
})

describe('relative conditions', () => {
  test('a spike fires above its threshold and not below', () => {
    expect(evaluate(base, 30, 10).fires).toBe(true) // +200% vs +50%
    expect(evaluate({ ...base, threshold: 500 }, 30, 10).fires).toBe(false)
  })

  test('a drop fires below its threshold and not above', () => {
    const drop = { condition: 'drop', threshold: 50, min_volume: 20 }
    expect(evaluate(drop, 5, 100).fires).toBe(true) // -95%
    expect(evaluate(drop, 90, 100).fires).toBe(false) // -10%
  })

  test('the volume floor applies to the observed count for a spike', () => {
    // Otherwise every quiet site alerts the moment two people arrive.
    expect(evaluate({ ...base, min_volume: 50 }, 30, 1).fires).toBe(false)
    expect(evaluate({ ...base, min_volume: 20 }, 30, 1).fires).toBe(true)
  })

  test('and to the baseline for a drop', () => {
    // Falling from two visitors to zero is not an outage, it is a Tuesday. Using
    // the observed side here instead would fire all night on a hobby blog.
    const drop = { condition: 'drop', threshold: 50, min_volume: 20 }
    expect(evaluate(drop, 0, 2).fires).toBe(false)
    expect(evaluate(drop, 0, 40).fires).toBe(true)
  })

  test('traffic where there was none fires, and says so rather than quoting a percentage', () => {
    const result = evaluate(base, 30, 0)
    expect(result.fires).toBe(true)
    expect(result.changePct).toBeNull()
    expect(result.reason).toContain('the usual is none')
  })
})

describe('absolute conditions', () => {
  test('above and below compare against the threshold, not a baseline', () => {
    expect(evaluate({ ...base, condition: 'above', threshold: 25 }, 30, 999).fires).toBe(true)
    expect(evaluate({ ...base, condition: 'above', threshold: 30 }, 30, 999).fires).toBe(false)
    expect(evaluate({ ...base, condition: 'below', threshold: 10 }, 5, 999).fires).toBe(true)
    expect(evaluate({ ...base, condition: 'below', threshold: 10 }, 10, 999).fires).toBe(false)
  })

  test('and report no baseline at all', () => {
    // Not "0": the template hides the column when this is null, which is honest,
    // where a zero would read as a measured value.
    expect(evaluate({ ...base, condition: 'above', threshold: 5 }, 30, 40).baseline).toBeNull()
  })

  test('the volume floor does not apply to them', () => {
    // An explicit "tell me when this drops under 10" must fire at 1, even though
    // 1 is far below any sensible noise floor for a percentage.
    expect(evaluate({ condition: 'below', threshold: 10, min_volume: 500 }, 1, null).fires).toBe(true)
  })
})

describe('cooldown', () => {
  const now = new Date('2026-08-12T12:00:00.000Z')

  test('an alert that has never fired is not suppressed', () => {
    expect(inCooldown({ cooldown_minutes: 60, last_fired_at: null }, now)).toBe(false)
  })

  test('suppresses inside the window and releases after it', () => {
    expect(inCooldown({ cooldown_minutes: 60, last_fired_at: '2026-08-12T11:30:00.000Z' }, now)).toBe(true)
    expect(inCooldown({ cooldown_minutes: 60, last_fired_at: '2026-08-12T10:30:00.000Z' }, now)).toBe(false)
  })

  test('an unparseable timestamp does not suppress forever', () => {
    // Failing open is right here: the alternative is an alert silently muted for
    // good by one bad write, which nobody would ever notice.
    expect(inCooldown({ cooldown_minutes: 60, last_fired_at: 'not a date' }, now)).toBe(false)
  })
})

describe('windows', () => {
  const now = new Date('2026-08-12T14:00:00.000Z')

  test('the observation window ends now', () => {
    const w = observationWindow(60, now)
    expect(w.to.toISOString()).toBe('2026-08-12T14:00:00.000Z')
    expect(w.from.toISOString()).toBe('2026-08-12T13:00:00.000Z')
  })

  test('baseline samples sit at the same clock time on previous days', () => {
    // This is the whole design: 09:00 is reliably busier than 08:00, so comparing
    // against the previous hour would report a spike every morning on every site.
    const windows = baselineWindows(60, 3, now)
    expect(windows.map(w => w.to.toISOString())).toEqual([
      '2026-08-11T14:00:00.000Z',
      '2026-08-10T14:00:00.000Z',
      '2026-08-09T14:00:00.000Z',
    ])
    expect(windows.every(w => w.to.getTime() - w.from.getTime() === 60 * 60_000)).toBe(true)
  })

  test('and none of them overlaps the observation', () => {
    const observation = observationWindow(180, now)
    expect(baselineWindows(180, 7, now).every(w => w.to <= observation.from)).toBe(true)
  })
})

describe('input validation', () => {
  test('metrics and conditions are matched, never defaulted', () => {
    for (const v of ['', 'Views', 'VISITORS', 'clicks', null, undefined, 1, {}]) {
      expect(isAlertMetric(v)).toBe(false)
      expect(isAlertCondition(v)).toBe(false)
    }
    expect(isAlertMetric('views')).toBe(true)
    expect(isAlertCondition('spike')).toBe(true)
  })

  test('only spike and drop consult a baseline', () => {
    expect(isRelative('spike')).toBe(true)
    expect(isRelative('drop')).toBe(true)
    expect(isRelative('above')).toBe(false)
    expect(isRelative('below')).toBe(false)
  })
})

describe('channels', () => {
  test('unrecognised entries are dropped, not defaulted', () => {
    // Inventing a destination for a malformed channel would mean sending a
    // customer's traffic data somewhere they never asked for.
    const channels = parseChannels(JSON.stringify([
      { type: 'email', to: 'a@b.com' },
      { type: 'email' }, // no address
      { type: 'sms', to: '+1' }, // not a channel we have
      { type: 'slack', url: 'https://hooks.slack.com/x' },
      { type: 'webhook' }, // no url
      'nonsense',
      null,
    ]))
    expect(channels).toEqual([
      { type: 'email', to: 'a@b.com' },
      { type: 'slack', url: 'https://hooks.slack.com/x' },
    ])
  })

  test('malformed json is no channels rather than a thrown run', () => {
    expect(parseChannels('{oops')).toEqual([])
    expect(parseChannels(null)).toEqual([])
    expect(parseChannels('{"not":"an array"}')).toEqual([])
  })

  test('the webhook payload carries the numbers behind the decision', () => {
    // A receiver that cannot see observed-vs-baseline can only relay the headline,
    // which makes the alert unactionable without opening the dashboard.
    const payload = webhookPayload({
      alert: { id: 'a1', name: 'Spike', metric: 'views', condition: 'spike', threshold: 50, window_minutes: 60 } as never,
      siteId: 'site1',
      siteName: 'Site One',
      evaluation: { fires: true, reason: 'x', observed: 30, baseline: 10, changePct: 200 },
      window: { from: new Date('2026-08-12T13:00:00Z'), to: new Date('2026-08-12T14:00:00Z') },
    })
    expect(payload.type).toBe('analytics.alert')
    expect(payload.observed).toBe(30)
    expect(payload.baseline).toBe(10)
    expect(payload.changePct).toBe(200)
  })
})

describe('the webhook address guard', () => {
  // A user-supplied webhook URL is a server-side request forgery primitive: the
  // request leaves our network, from our address, to wherever they name.
  test('refuses the addresses that make SSRF worth attempting', () => {
    for (const address of [
      '169.254.169.254', // cloud instance metadata — the prize
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0',
      '255.255.255.255',
      '224.0.0.1', // multicast
    ])
      expect(isBlockedAddress(address), address).toBe(true)
  })

  test('refuses the same internal address however it is spelled', () => {
    // Every one of these reaches 169.254.169.254 or 127.0.0.1. The v4-mapped hex
    // form is the one that actually got through an earlier version of this guard:
    // `new URL()` rewrites [::ffff:169.254.169.254] to ::ffff:a9fe:a9fe, so a
    // check looking for a dotted quad found nothing to unwrap.
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::7f00:1', // v4-compatible, deprecated but still routed
      '2002:a9fe:a9fe::', // 6to4
      '64:ff9b::a9fe:a9fe', // NAT64
      'fe80::1', // link-local
      'fc00::1', // unique-local, low end of fc00::/7
      'fd00::1', // unique-local
      'ff02::1', // multicast
    ])
      expect(isBlockedAddress(address), address).toBe(true)
  })

  test('but does not block the public internet wholesale', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])
      expect(isBlockedAddress(address), address).toBe(false)
  })

  test('anything it cannot parse is refused rather than guessed at', () => {
    for (const address of ['', '  ', 'localhost', 'not-an-address', '1.2.3', '1.2.3.4.5', '999.1.1.1', '0x7f.0.0.1', '::gggg'])
      expect(isBlockedAddress(address), address).toBe(true)
  })

  test('decimal-only octets, so our parser and the connection cannot disagree', () => {
    // 0177.0.0.1 is 127.0.0.1 to an octal-aware resolver. Rather than guess which
    // interpretation the socket will take, refuse the ambiguity.
    expect(isBlockedAddress('0177.0.0.1')).toBe(true)
    expect(isBlockedAddress('010.0.0.1')).toBe(true)
  })
})

describe('the webhook url shape', () => {
  test('https only', () => {
    expect(checkUrlShape('http://example.com/hook').ok).toBe(false)
    expect(checkUrlShape('https://example.com/hook').ok).toBe(true)
  })

  test('no embedded credentials, and no port scanning', () => {
    expect(checkUrlShape('https://user:pw@example.com/hook').ok).toBe(false)
    // Response timing alone distinguishes an open internal port from a closed one,
    // so an endpoint that merely attempts the connection leaks the network's shape.
    expect(checkUrlShape('https://example.com:8080/hook').ok).toBe(false)
    expect(checkUrlShape('https://example.com:443/hook').ok).toBe(true)
  })

  test('and nothing that is not a url at all', () => {
    for (const raw of ['', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)'])
      expect(checkUrlShape(raw).ok, raw).toBe(false)
  })
})

describe('the wiring a later edit could quietly loosen', () => {
  const routes = read('routes/analytics.ts')

  test('every alert endpoint requires admin, including the list', () => {
    // Not viewer, unlike goals and members. `channels` holds a Slack webhook URL,
    // which is a bearer credential: anyone holding one can post to that channel as
    // this app, forever. Reading a site's numbers does not imply that.
    const paths = [
      `route.get('/api/sites/{siteId}/alerts'`,
      `route.post('/api/sites/{siteId}/alerts'`,
      `route.patch('/api/sites/{siteId}/alerts/{alertId}'`,
      `route.delete('/api/sites/{siteId}/alerts/{alertId}'`,
    ]
    for (const path of paths) {
      const i = routes.indexOf(path)
      expect(i, `${path} is missing`).toBeGreaterThan(-1)
      const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
      expect(block, path).toContain(`requireSiteRole(request, siteId, 'admin')`)
    }
  })

  test('a goal can only be attached if it belongs to this site', () => {
    // Otherwise an admin on one site points an alert at another site's goal and
    // reads its conversion counts out of the notification body.
    expect(routes).toContain('That goal does not belong to this site')
  })

  test('the update path is scoped by site as well as alert id', () => {
    const i = routes.indexOf(`route.patch('/api/sites/{siteId}/alerts/{alertId}'`)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect(block).toContain('WHERE id = ? AND site_id = ?')
  })

  test('the job is scheduled hourly, not daily like the digest', () => {
    // A collapse found the next morning is a post-mortem, not an alert.
    const scheduler = read('app/Scheduler.ts')
    expect(scheduler).toContain(`job('RunAnalyticsAlerts')`)
    const block = scheduler.slice(scheduler.indexOf('RunAnalyticsAlerts'))
    expect(block).toContain('.hourly()')
  })

  test('delivery refuses to follow redirects', () => {
    // Every address check runs against the URL we were given, so a 302 to the
    // metadata service would launder a request past all of them. fetch follows
    // redirects by default, which makes the default wrong here.
    const delivery = code('app/Alerts/delivery.ts')
    expect(delivery).toContain(`redirect: 'error'`)
    expect(delivery).not.toContain(`redirect: 'follow'`)
  })

  test('and re-checks the URL at send time, not only when it was saved', () => {
    // DNS is mutable: a hostname that resolved to a public address when the
    // channel was created can be repointed afterwards.
    const delivery = code('app/Alerts/delivery.ts')
    const i = delivery.indexOf('export async function postJson')
    expect(i).toBeGreaterThan(-1)
    expect(delivery.slice(i, i + 600)).toContain('checkWebhookUrl')
  })

  test('the cooldown is stamped before delivery is attempted', () => {
    // The other order costs a duplicate notification when a send is slow enough
    // for the next hourly run to overlap it, and duplicates are what teach people
    // to mute a channel.
    const job = code('app/Jobs/RunAnalyticsAlerts.ts')
    const stamp = job.indexOf('await markFired')
    const send = job.indexOf('await deliver')
    // Both must EXIST. Asserting only the ordering passes when the stamp is gone
    // entirely: indexOf returns -1, which is dutifully less than everything.
    // Deleting the call was a sabotage this test originally failed to catch.
    expect(stamp, 'markFired is not called at all').toBeGreaterThan(-1)
    expect(send, 'deliver is not called at all').toBeGreaterThan(-1)
    expect(stamp).toBeLessThan(send)
  })
})
