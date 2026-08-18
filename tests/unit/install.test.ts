import { describe, expect, test } from 'bun:test'
import { snippetFor } from '../../app/Analytics/custom-domain'
import {
  ENDTAG_TOKEN,
  installTargets,
  normalizeOrigin,
  ORIGIN_TOKEN,
  PACKAGE_NAME,
  renderInstallCode,
  TAG_TOKEN,
} from '../../app/Analytics/install'

const SITE = 'site_abc123'
const targets = installTargets(SITE)
const byId = (id: string) => targets.find(t => t.id === id)!

describe('normalizeOrigin', () => {
  test('gives a bare host a scheme', () => {
    // config.app.url is stored without one. Left alone it produced
    // src="ghostanalytics.localhost/script.js" — relative to the CUSTOMER's
    // site, so the tracker 404s and the site reports nothing at all.
    expect(normalizeOrigin('analyticshq.org')).toBe('https://analyticshq.org')
  })

  test('a .localhost host gets http, not https', () => {
    // Nothing mints a public cert for *.localhost, and the dev server speaks
    // http. https:// here would fail to load rather than merely look wrong.
    expect(normalizeOrigin('ghostanalytics.localhost')).toBe('http://ghostanalytics.localhost')
    expect(normalizeOrigin('localhost:2026')).toBe('http://localhost:2026')
    expect(normalizeOrigin('127.0.0.1:2026')).toBe('http://127.0.0.1:2026')
  })

  test('an explicit scheme is preserved, including http on a real host', () => {
    expect(normalizeOrigin('https://analyticshq.org')).toBe('https://analyticshq.org')
    // Not upgraded to https: the caller said http, and silently changing it
    // would point the snippet somewhere that may not answer.
    expect(normalizeOrigin('http://analyticshq.org')).toBe('http://analyticshq.org')
  })

  test('trailing slashes never survive into the URL', () => {
    // The caller appends "/script.js"; a kept slash yields a "//script.js" path.
    expect(normalizeOrigin('https://analyticshq.org/')).toBe('https://analyticshq.org')
    expect(normalizeOrigin('analyticshq.org///')).toBe('https://analyticshq.org')
  })

  test('empty input stays empty rather than becoming "https://"', () => {
    expect(normalizeOrigin('')).toBe('')
    expect(normalizeOrigin('   ')).toBe('')
  })
})

describe('the install targets', () => {
  test('cover the frameworks the tabs advertise', () => {
    expect(targets.map(t => t.id)).toEqual(['html', 'nuxt', 'vue', 'react', 'next', 'svelte'])
  })

  test('every target carries a label, a file and a note', () => {
    // A tab with no `file` renders a heading with nothing under it; a missing
    // note is how "add it to <head>" becomes the whole instruction again.
    for (const t of targets) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.file.length).toBeGreaterThan(0)
      expect(t.note.length).toBeGreaterThan(0)
    }
  })

  test('every target embeds the site id', () => {
    for (const t of targets)
      expect(t.code).toContain(SITE)
  })

  test('no target hardcodes a host', () => {
    // The entire bug this replaced: a developer on localhost was shown
    // https://analyticshq.org and every pageview went to the live site.
    for (const t of targets) {
      expect(t.code).not.toContain('analyticshq.org')
      expect(t.code).not.toContain('localhost')
      expect(t.code).toContain(ORIGIN_TOKEN)
    }
  })

  test('no target contains a literal script tag before rendering', () => {
    // These strings cross stx's client payload bridge and land inside an inline
    // script. A literal </script> there closes that tag early and kills the
    // rest of the page bundle.
    for (const t of targets) {
      expect(t.code).not.toContain('<script')
      expect(t.code).not.toContain('</script>')
    }
  })

  test('the nuxt target names the package that is actually published', () => {
    // The module's own docstring says @stacksjs/ts-analytics, which is stuck at
    // 0.1.6. Repeating that here would ship users a stale SDK.
    const nuxt = byId('nuxt')
    expect(nuxt.code).toContain(`${PACKAGE_NAME}/nuxt`)
    expect(nuxt.code).not.toContain('@stacksjs/ts-analytics')
  })

  test('the next target uses next/script rather than a raw tag', () => {
    const next = byId('next')
    expect(next.code).toContain('next/script')
    expect(next.code).toContain('strategy="afterInteractive"')
    expect(next.code).not.toContain(TAG_TOKEN)
  })

  test('the sveltekit target keeps the head placeholder', () => {
    // Dropping %sveltekit.head% from app.html breaks the whole app, so the
    // snippet has to show it being kept rather than replaced.
    expect(byId('svelte').code).toContain('%sveltekit.head%')
  })
})

describe('renderInstallCode', () => {
  test('substitutes the real origin', () => {
    const out = renderInstallCode(byId('html').code, 'http://localhost:2026')
    expect(out).toContain('src="http://localhost:2026/script.js"')
    expect(out).not.toContain(ORIGIN_TOKEN)
  })

  test('normalizes the origin it is handed', () => {
    // window.location.origin always has a scheme, but the same helper renders
    // server-side values that may not.
    expect(renderInstallCode(byId('html').code, 'analyticshq.org')).toContain('src="https://analyticshq.org/script.js"')
  })

  test('produces a real script tag', () => {
    const out = renderInstallCode(byId('html').code, 'https://analyticshq.org')
    expect(out).toBe('<script defer src="https://analyticshq.org/script.js" data-site="site_abc123"></script>')
  })

  test('leaves no token behind in any target', () => {
    for (const t of targets) {
      const out = renderInstallCode(t.code, 'https://analyticshq.org')
      expect(out).not.toContain(ORIGIN_TOKEN)
      expect(out).not.toContain(TAG_TOKEN)
      expect(out).not.toContain(ENDTAG_TOKEN)
    }
  })

  test('substitutes every occurrence, not just the first', () => {
    // split/join rather than replace(): the vue and svelte snippets would keep
    // a raw token on a second line with a non-global replace.
    const doubled = `${ORIGIN_TOKEN}/a ${ORIGIN_TOKEN}/b`
    expect(renderInstallCode(doubled, 'https://x.test')).toBe('https://x.test/a https://x.test/b')
  })
})

describe('the API snippet agrees with the dashboard', () => {
  test('a scheme-less app url is given one', () => {
    // routes/analytics.ts passes config.app.url straight in.
    const out = snippetFor(SITE, 'ghostanalytics.localhost', null, null)
    expect(out).toContain('src="http://ghostanalytics.localhost/script.js"')
  })

  test('matches the html target byte for byte', () => {
    // Two code paths emit "the snippet". They drifting apart is how a support
    // answer stops matching what the dashboard shows.
    const fromApi = snippetFor(SITE, 'https://analyticshq.org', null, null)
    const fromDashboard = renderInstallCode(byId('html').code, 'https://analyticshq.org')
    expect(fromApi).toBe(fromDashboard)
  })

  test('a verified custom domain still wins', () => {
    const out = snippetFor(SITE, 'https://analyticshq.org', 'stats.customer.com', '2026-08-18T00:00:00Z')
    expect(out).toContain('src="https://stats.customer.com/script.js"')
  })

  test('an unverified custom domain is ignored', () => {
    const out = snippetFor(SITE, 'https://analyticshq.org', 'stats.customer.com', null)
    expect(out).toContain('src="https://analyticshq.org/script.js"')
  })
})
