/**
 * `data-environment` on the tracker's script tag (#60).
 *
 * Stacks decides whether a site reports from an environment before it injects
 * the snippet, and then tells the tracker which one it is in. The tracker's
 * whole job is to carry that label: read it once, attach the same value to
 * every beacon, and change nothing at all when it is absent. /collect's job is
 * to keep only a short, well-formed label and to never refuse a beacon over it.
 *
 * The tracker is run for real inside a small fake DOM, like
 * tracker-markup-events.test.ts, because what matters is the exact body that
 * reaches /collect, not the shape of the source.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENVIRONMENT_PATTERN, MAX_ENVIRONMENT_LENGTH, normalizeEnvironment } from '../../app/Analytics/environment'

const ROOT = join(import.meta.dir, '../..')
const source = readFileSync(join(ROOT, 'public/script.js'), 'utf8')

/** Just enough of an Element for the click listener: `closest`, attributes and `href`. */
interface FakeNode {
  href: string | undefined
  attributes: Array<{ name: string, value: string }>
  getAttribute: (name: string) => string | null
  hasAttribute: (name: string) => boolean
  closest: (selector: string) => FakeNode | null
}

/** A single, parentless element: every test here clicks the element itself. */
function node(tag: string, attrs: Record<string, string>): FakeNode {
  const self: FakeNode = {
    href: attrs.href ? new URL(attrs.href, 'https://fan.example/').href : undefined,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: name => attrs[name] ?? null,
    hasAttribute: name => name in attrs,
    closest: (selector) => {
      if (selector === 'a')
        return tag === 'a' ? self : null
      const attr = selector.match(/^\[([\w-]+)\]$/)?.[1]
      return attr && attr in attrs ? self : null
    },
  }
  return self
}

type Listener = (ev?: unknown) => void

/**
 * Load the tracker with the given script-tag attributes. Returns every raw body
 * it posted (strings, so a test can compare bytes, not just parsed shape), and
 * handles for the three ways a beacon leaves: the page view on load,
 * `window.analyticshq` / a click, and the vitals flush on pagehide.
 */
function load(attrs: Record<string, string>) {
  const sent: string[] = []
  const docListeners: Record<string, Listener[]> = {}
  const winListeners: Record<string, Listener[]> = {}
  const observers: Record<string, (list: { getEntries: () => unknown[] }) => void> = {}

  class FakePerformanceObserver {
    constructor(private fn: (list: { getEntries: () => unknown[] }) => void) {}
    observe(opts: { type: string }) { observers[opts.type] = this.fn }
  }

  const document = {
    currentScript: {
      src: 'https://analyticshq.org/script.js',
      getAttribute: (name: string) => ({ 'data-site': 'site123', ...attrs } as Record<string, string>)[name] ?? null,
    },
    referrer: '',
    visibilityState: 'visible',
    addEventListener: (type: string, fn: Listener) => { (docListeners[type] ??= []).push(fn) },
  }
  const window: Record<string, unknown> = {
    PerformanceObserver: FakePerformanceObserver,
    addEventListener: (type: string, fn: Listener) => { (winListeners[type] ??= []).push(fn) },
  }
  const location = { href: 'https://fan.example/tour', origin: 'https://fan.example', pathname: '/tour', search: '', hostname: 'fan.example' }
  const fetch = (_url: string, init?: RequestInit) => { sent.push(String(init?.body)) }
  const performance = { getEntriesByType: () => [] }

  // eslint-disable-next-line no-new-func
  new Function('document', 'window', 'location', 'navigator', 'history', 'fetch', 'PerformanceObserver', 'performance', source)(
    document, window, location, {}, { pushState() {} }, fetch, FakePerformanceObserver, performance,
  )

  return {
    sent,
    parsed: () => sent.map(body => JSON.parse(body) as Record<string, unknown>),
    track: (name: string, props?: Record<string, unknown>) => (window.analyticshq as (n: string, p?: unknown) => void)(name, props),
    click: (target: FakeNode) => docListeners.click?.forEach(fn => fn({ type: 'click', target })),
    /** Report an LCP, then hide the page, which is when the tracker flushes vitals. */
    vitals: () => {
      observers['largest-contentful-paint']?.({ getEntries: () => [{ startTime: 1234 }] })
      winListeners.pagehide?.forEach(fn => fn())
    },
  }
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

describe('with data-environment', () => {
  test('the page view carries it', () => {
    const { parsed } = load({ 'data-environment': 'staging' })
    expect(parsed()[0]).toEqual(expect.objectContaining({ e: 'pageview', environment: 'staging' }))
  })

  test('a custom event from window.analyticshq carries it, outside the event properties', () => {
    const { parsed, track } = load({ 'data-environment': 'staging' })
    track('Signup', { plan: 'pro' })
    const event = parsed()[1]
    expect(event).toEqual(expect.objectContaining({ e: 'Signup', environment: 'staging', p: { plan: 'pro' } }))
  })

  test('a markup event and an outbound link carry it', () => {
    const { parsed, click } = load({ 'data-environment': 'staging' })
    click(node('button', { 'data-analyticshq-event': 'Play', 'data-analyticshq-video': 'intro' }))
    click(node('a', { href: 'https://elsewhere.example/' }))
    const [markup, outbound] = parsed().slice(1)
    expect(markup).toEqual(expect.objectContaining({ e: 'Play', environment: 'staging', p: { video: 'intro' } }))
    expect(outbound).toEqual(expect.objectContaining({ e: 'Outbound Link', environment: 'staging' }))
  })

  test('the Web Vitals beacon carries it, outside the metrics', () => {
    const { parsed, vitals } = load({ 'data-environment': 'staging' })
    vitals()
    const beacon = parsed().find(b => b.e === 'vitals')
    expect(beacon).toEqual(expect.objectContaining({ environment: 'staging', p: { LCP: 1234 } }))
  })

  test('every beacon carries the same value', () => {
    const { parsed, track, click, vitals } = load({ 'data-environment': 'preview-42' })
    track('Signup')
    click(node('a', { href: 'https://elsewhere.example/' }))
    vitals()
    const all = parsed()
    expect(all.map(b => b.e)).toEqual(['pageview', 'Signup', 'Outbound Link', 'vitals'])
    expect(new Set(all.map(b => b.environment))).toEqual(new Set(['preview-42']))
  })

  test('is sent as written: normalizing it is the ingest\'s job, not the tracker\'s', () => {
    // One rule in one place. A tracker that also trimmed or lowercased would be
    // a second copy of it, cached on customer sites where it cannot be updated.
    const { parsed } = load({ 'data-environment': 'Staging' })
    expect(parsed()[0].environment).toBe('Staging')
  })

  test('is metadata, not a switch: every value still reports', () => {
    for (const value of ['production', 'development', 'off', 'false', '0']) {
      const { sent } = load({ 'data-environment': value })
      expect({ value, beacons: sent.length }).toEqual({ value, beacons: 1 })
    }
  })
})

describe('without data-environment', () => {
  // The exact bytes the tracker sent before #60. Compared as strings, so an
  // added `"environment":null` or `"environment":""` fails here even though
  // it would pass an objectContaining check.
  const PAGEVIEW = '{"s":"site123","e":"pageview","p":{},"u":"https://fan.example/tour","r":""}'
  const EVENT = '{"s":"site123","e":"Signup","p":{"plan":"pro"},"u":"https://fan.example/tour","r":""}'
  const OUTBOUND = '{"s":"site123","e":"Outbound Link","p":{"url":"https://elsewhere.example/"},"u":"https://fan.example/tour","r":""}'
  const VITALS = '{"s":"site123","e":"vitals","p":{"LCP":1234},"u":"https://fan.example/tour","r":""}'

  for (const [label, attrs] of [['absent', {}], ['empty', { 'data-environment': '' }]] as const) {
    test(`${label}: page view, custom event, outbound link and vitals are byte-for-byte unchanged`, () => {
      const { sent, track, click, vitals } = load(attrs)
      track('Signup', { plan: 'pro' })
      click(node('a', { href: 'https://elsewhere.example/' }))
      vitals()
      expect(sent).toEqual([PAGEVIEW, EVENT, OUTBOUND, VITALS])
    })
  }

  test('the attribute is read once, while the script is executing', () => {
    // currentScript is null once this pass ends, so a read inside send() would
    // silently drop the label from every beacon after the first.
    const reads = [...source.matchAll(/getAttribute\('data-environment'\)/g)]
    expect(reads).toHaveLength(1)
    const sendAt = source.indexOf('function send')
    expect(reads[0].index).toBeLessThan(sendAt)
  })
})

// ---------------------------------------------------------------------------
// The ingest boundary
// ---------------------------------------------------------------------------

describe('normalizeEnvironment', () => {
  test('keeps a short label, trimmed and lowercased', () => {
    expect(normalizeEnvironment('staging')).toBe('staging')
    expect(normalizeEnvironment('  Production ')).toBe('production')
    expect(normalizeEnvironment('preview-42')).toBe('preview-42')
    expect(normalizeEnvironment('eu_west.2')).toBe('eu_west.2')
    expect(normalizeEnvironment('a'.repeat(MAX_ENVIRONMENT_LENGTH))).toBe('a'.repeat(MAX_ENVIRONMENT_LENGTH))
  })

  test('trims surrounding whitespace, including a newline', () => {
    expect(normalizeEnvironment('staging\n')).toBe('staging')
    expect(normalizeEnvironment('\tqa ')).toBe('qa')
  })

  test('drops anything else to null rather than storing it', () => {
    for (const value of [
      '',
      '   ',
      'a'.repeat(MAX_ENVIRONMENT_LENGTH + 1),
      '-staging',
      '.hidden',
      '_x',
      'stag ing',
      'staging/eu',
      'staging:eu',
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      'staging\'; DROP TABLE page_views; --',
      'stag\u00EDng',
      'staging\u0000',
      'staging\u202E',
    ])
      expect({ value, normalized: normalizeEnvironment(value) }).toEqual({ value, normalized: null })
  })

  test('refuses non-strings instead of coercing them', () => {
    for (const value of [null, undefined, 42, true, {}, ['staging'], { toString: () => 'staging' }])
      expect(normalizeEnvironment(value)).toBeNull()
  })

  test('the pattern\'s upper bound and the column width agree', () => {
    // A label the pattern accepts must never be truncated by the column.
    expect(ENVIRONMENT_PATTERN.test('a'.repeat(MAX_ENVIRONMENT_LENGTH))).toBe(true)
    expect(ENVIRONMENT_PATTERN.test('a'.repeat(MAX_ENVIRONMENT_LENGTH + 1))).toBe(false)
  })
})

describe('/collect stores it on all three paths', () => {
  // Comments stripped, so prose explaining a rule cannot satisfy it.
  const code = readFileSync(join(ROOT, 'routes/analytics.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const collect = code.slice(code.indexOf(`route.post('/collect'`), code.indexOf('.skipCsrf()', code.indexOf(`route.post('/collect'`)))

  test('the body value only ever reaches the database through normalizeEnvironment', () => {
    const reads = [...collect.matchAll(/body\.environment/g)]
    expect(reads).toHaveLength(1)
    expect(collect).toContain('const environment = normalizeEnvironment(body.environment)')
  })

  test('it is normalized before the vitals branch returns early', () => {
    expect(collect.indexOf('normalizeEnvironment(')).toBeGreaterThan(0)
    expect(collect.indexOf('normalizeEnvironment(')).toBeLessThan(collect.indexOf(`if (body.e === 'vitals') {`))
  })

  test('the Web Vitals insert names the column, with a placeholder for it', () => {
    const insert = collect.match(/INSERT INTO web_vitals \(([^)]+)\) VALUES/)
    expect(insert).not.toBeNull()
    const columns = insert![1].split(',').map(c => c.trim())
    expect(columns.at(-1)).toBe('environment')
    const params = collect.match(/samples\.flatMap\(s => \[([^\]]+)\]\)/)
    expect(params).not.toBeNull()
    expect(params![1].split(',').map(p => p.trim()).at(-1)).toBe('environment')
    const tuple = collect.match(/const placeholders = samples\.map\(\(\) => `\(([^`]+)\)`\)/)
    expect(tuple![1].split(',')).toHaveLength(columns.length)
  })

  test('the page view and custom event inserts write it', () => {
    for (const table of ['page_views', 'custom_events']) {
      const start = collect.indexOf(`insertInto('${table}')`)
      expect(start).toBeGreaterThan(0)
      const values = collect.slice(start, collect.indexOf('.execute()', start))
      expect({ table, writes: /\benvironment,/.test(values) }).toEqual({ table, writes: true })
    }
  })
})

describe('the columns', () => {
  const migration = readdirSync(join(ROOT, 'database/migrations')).find(f => f.includes('add-environment-to-events'))

  test('a migration adds a nullable varchar(32) to each of the three tables', () => {
    expect(migration).toBeDefined()
    const sql = readFileSync(join(ROOT, 'database/migrations', migration!), 'utf8')
    for (const table of ['page_views', 'custom_events', 'web_vitals'])
      expect(sql).toContain(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "environment" varchar(${MAX_ENVIRONMENT_LENGTH});`)
    expect(sql).not.toMatch(/"environment"[^;]*NOT NULL/i)
  })

  test('each model declares it with the same width, so the differ neither drops nor resizes it', () => {
    for (const file of ['PageView.ts', 'CustomEvent.ts', 'WebVital.ts']) {
      const src = readFileSync(join(ROOT, 'app/Models', file), 'utf8')
      expect({ file, declared: new RegExp(`environment: \\{[^}]*schema\\.string\\(\\)\\.optional\\(\\)\\.max\\(${MAX_ENVIRONMENT_LENGTH}\\)`).test(src) }).toEqual({ file, declared: true })
    }
  })
})
