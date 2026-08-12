/**
 * Embeddable public widgets (#26).
 *
 * These are the only routes in the app besides /collect that serve data without
 * authentication, so the two decisions that make that safe are asserted here
 * rather than left to the section comment explaining them:
 *
 *   1. the widget token is NOT the dashboard share token
 *   2. a widget exposes totals and a daily series, and no dimensions
 *
 * The badge itself is rendered into somebody else's page as an <img>, so the
 * label sanitiser is tested against the things that would break the SVG or
 * escape it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatCount, renderBadge, renderSparkline, sanitizeLabel } from '../../app/Analytics/badge'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/**
 * The CODE of one route section, bounded by the next section divider.
 *
 * Located in the raw source, because the boundaries are comments — then stripped,
 * because the assertions below are about what the code does. Without the strip,
 * the section's own header comment explaining that widgets have no segment filter
 * contains the word "segment", and the test asserting there is no segment filter
 * fails on the sentence saying so.
 */
function section(marker: string): string {
  const raw = read('routes/analytics.ts')
  const start = raw.indexOf(marker)
  if (start === -1)
    return ''
  const divider = /^\/\/ -{10,}$/m
  const afterHeader = start + raw.slice(start).search(divider) + 1
  const rest = raw.slice(afterHeader)
  const offset = rest.search(divider)
  return raw.slice(afterHeader, offset === -1 ? raw.length : afterHeader + offset)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the widget token is not the share token', () => {
  const routes = code('routes/analytics.ts')

  test('they are minted from different inputs and stored under different keys', () => {
    // A badge lives in an <img src> in public page source, so its token is public
    // by construction. Reusing share_token would mean embedding a visitor count
    // silently publishes the whole dashboard — every path, referrer and country —
    // to anyone who views source.
    expect(routes).toContain('settings.widget_token = token')
    expect(routes).toContain('settings.share_token = token')
    expect(routes).toContain('|widget`')
    expect(routes).toContain('|share`')
  })

  test('the public widget lookup reads widget_token and never share_token', () => {
    const i = routes.indexOf('async function widgetSite')
    expect(i).toBeGreaterThan(-1)
    const block = routes.slice(i, i + 500)
    expect(block).toContain('settings.widget_token')
    expect(block).not.toContain('share_token')
  })

  test('revoking one does not touch the other', () => {
    const i = routes.indexOf(`route.delete('/api/sites/{siteId}/widget'`)
    const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
    expect(block).toContain('delete settings.widget_token')
    expect(block).not.toContain('share_token')
  })

  test('minting is admin-only', () => {
    for (const path of [`route.post('/api/sites/{siteId}/widget'`, `route.delete('/api/sites/{siteId}/widget'`]) {
      const i = routes.indexOf(path)
      expect(i, path).toBeGreaterThan(-1)
      const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))
      expect(block, path).toContain(`requireSiteRole(request, siteId, 'admin')`)
    }
  })
})

describe('what a public widget may expose', () => {
  const widgets = section('// Embeddable public widgets (#26)')

  test('the section exists and is substantial', () => {
    // An empty slice would satisfy every "does not contain" below while proving
    // nothing.
    expect(widgets.length).toBeGreaterThan(2000)
  })

  test('no dimension is ever selected', () => {
    // Top paths on a public endpoint leak internal and unreleased URLs:
    // /admin/project-titan, /blog/the-post-we-have-not-announced. Countries and
    // referrers are the same problem in a different column.
    for (const column of ['path', 'referrer_source', 'country', 'device_type', 'browser', 'os', 'utm_source'])
      expect(widgets, column).not.toContain(`SELECT ${column}`)
    expect(widgets).not.toContain('GROUP BY path')
    expect(widgets).not.toContain('topDimension')
  })

  test('and no filter can be applied', () => {
    // No filters is also what keeps a public surface clear of the
    // re-identification problem that narrowing an aggregate to one person creates.
    expect(widgets).not.toContain('readFilters')
    expect(widgets).not.toContain('readFiltersWithSegment')
    expect(widgets).not.toContain('segment')
  })

  test('the only aggregates are counts over the whole site', () => {
    // visitor_id appears only inside COUNT(DISTINCT ...), never as a selected
    // column — the same line the funnel query holds.
    const selects = widgets.match(/SELECT[\s\S]*?FROM/g) ?? []
    expect(selects.length).toBeGreaterThan(0)
    for (const select of selects) {
      if (!select.includes('visitor_id'))
        continue
      expect(select).toContain('COUNT(DISTINCT visitor_id)')
      expect(select).not.toMatch(/SELECT\s+visitor_id/)
    }
  })

  test('the lookback is bounded', () => {
    // An unbounded `days` on a public, cacheable endpoint is a free full-table
    // scan for anyone holding the badge URL.
    expect(widgets).toContain('Math.min(365')
  })

  test('a missing site, a missing token and a wrong token answer identically', () => {
    // Distinguishing them turns a public site id into a way to enumerate which
    // sites have widgets enabled.
    const i = widgets.indexOf(`route.get('/api/public/{siteId}/summary'`)
    const block = widgets.slice(i, widgets.indexOf('\nroute.', i + 10))
    expect(block).toContain(`json({ error: 'Not found' }, 404)`)
  })
})

describe('token comparison', () => {
  const routes = code('routes/analytics.ts')

  test('is constant-time, and over equal-length inputs', () => {
    // timingSafeEqual throws on a length mismatch, so comparing raw tokens would
    // need a try/catch that is itself a length oracle. Hashing first makes both
    // sides 32 bytes always.
    const i = routes.indexOf('function tokensMatch')
    expect(i).toBeGreaterThan(-1)
    const block = routes.slice(i, i + 500)
    expect(block).toContain('timingSafeEqual')
    expect(block).toContain(`createHash('sha256')`)
    expect(block).not.toContain('===')
  })
})

describe('the badge', () => {
  test('renders a self-contained svg', () => {
    const svg = renderBadge({ label: 'visitors', value: '1.2k' })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    // Nothing that fetches or executes. An <img> would not run them anyway, and
    // depending on one would mean a badge that breaks silently on a page we do
    // not control.
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('@import')
    expect(svg).not.toContain('xlink:href')
    expect(svg).not.toContain('href=')

    // The ONLY URL may be the SVG namespace, which is an identifier rather than
    // something the renderer fetches. Asserting "no http" outright fails on it —
    // that was this test's first mistake.
    const urls = svg.match(/https?:\/\/[^"'\s)]+/g) ?? []
    expect(urls).toEqual(['http://www.w3.org/2000/svg'])
  })

  test('carries an accessible name', () => {
    // It is an image on somebody else's page; a bare SVG announces nothing.
    const svg = renderBadge({ label: 'visitors', value: '42' })
    expect(svg).toContain('role="img"')
    expect(svg).toContain('aria-label="visitors: 42"')
    expect(svg).toContain('<title>visitors: 42</title>')
  })

  test('a hostile label cannot break out of the markup', () => {
    // An allowlist, not an escape: the safe set here is small and easy to state.
    const svg = renderBadge({ label: '</text><script>alert(1)</script>', value: '1' })
    expect(svg).not.toContain('<script')

    // The property is that nothing markup-significant survives the SANITISER —
    // not that the badge contains no '</text><', which is its own valid markup
    // between the two text elements. That was this test's first mistake.
    for (const hostile of ['</text><script>alert(1)</script>', '"><script>x</script>', 'a&b<c>d', `'"><`]) {
      const clean = sanitizeLabel(hostile, 'fallback')
      expect(clean, hostile).not.toMatch(/[<>&"']/)
    }
    expect(sanitizeLabel('"><script>x</script>', 'fallback')).toBe('scriptxscript')
    expect(sanitizeLabel('a&b<c>d', 'fallback')).toBe('abcd')
  })

  test('an empty or non-string label falls back rather than rendering blank', () => {
    for (const bad of ['', '   ', '&&&', null, undefined, 42, {}])
      expect(sanitizeLabel(bad, 'visitors'), JSON.stringify(bad)).toBe('visitors')
  })

  test('a hostile colour is ignored', () => {
    const svg = renderBadge({ label: 'v', value: '1', color: '#fff" onload="alert(1)' })
    expect(svg).not.toContain('onload')
    expect(renderBadge({ label: 'v', value: '1', color: '#ff0000' })).toContain('#ff0000')
  })

  test('the box grows with the text, so a big number is not clipped', () => {
    const small = renderBadge({ label: 'visitors', value: '1' })
    const large = renderBadge({ label: 'visitors', value: '123.4k' })
    const widthOf = (svg: string) => Number(svg.match(/width="(\d+)"/)?.[1] ?? 0)
    expect(widthOf(large)).toBeGreaterThan(widthOf(small))
  })
})

describe('compacting a count', () => {
  test('the ordinary ranges', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(1234)).toBe('1.2k')
    expect(formatCount(999_999)).toBe('999.9k')
    expect(formatCount(1_000_000)).toBe('1M')
    expect(formatCount(1_234_567)).toBe('1.2M')
  })

  test('rounds down, so a badge never claims a milestone not reached', () => {
    // "1M visitors" at 999,999 is the kind of small lie that gets screenshotted.
    expect(formatCount(999_999)).not.toBe('1M')
    expect(formatCount(1999)).toBe('1.9k')
  })

  test('never renders a negative or fractional count', () => {
    expect(formatCount(-5)).toBe('0')
    expect(formatCount(1.7)).toBe('1')
  })
})

describe('the sparkline', () => {
  test('scales to its own maximum, so a quiet site still has a shape', () => {
    const svg = renderSparkline([1, 5, 2])
    expect(svg).toContain('<polyline')
    // The peak touches the top of the box.
    expect(svg).toMatch(/points="[^"]*,0\.0/)
  })

  test('an empty or all-zero series is a flat line, not NaN', () => {
    // Browsers drop NaN coordinates silently, which looks like a rendering bug
    // rather than an absence of data.
    for (const series of [[], [0], [0, 0, 0]]) {
      const svg = renderSparkline(series)
      expect(svg, JSON.stringify(series)).not.toContain('NaN')
      expect(svg).toContain('<polyline')
    }
  })

  test('grows downward never', () => {
    // SVG y grows downward; a rising series must produce a falling y.
    const svg = renderSparkline([1, 10])
    const points = svg.match(/points="([^"]+)"/)?.[1] ?? ''
    const ys = points.split(' ').map(p => Number(p.split(',')[1]))
    expect(ys[1]).toBeLessThan(ys[0])
  })
})
