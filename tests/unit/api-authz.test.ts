/**
 * API authorization guardrail (issue #3).
 *
 * Site ids are public (they ride in the tracking snippet), so every site-scoped
 * read endpoint MUST be owner-gated — otherwise anyone could read any site's
 * stats. This asserts against the real route source so the gate can't be removed
 * without a red test.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const analytics = readFileSync(join(import.meta.dir, '../../routes/analytics.ts'), 'utf8')

/** Isolate a single `route.<verb>('<path>', ...)` block up to the next route. */
function routeBlock(path: string): string {
  const start = analytics.indexOf(`'${path}'`)
  if (start === -1)
    return ''
  const rest = analytics.slice(start)
  const end = rest.indexOf('\nroute.')
  return end === -1 ? rest : rest.slice(0, end)
}

const READ_ENDPOINTS = [
  '/api/sites/{siteId}/stats',
  '/api/sites/{siteId}/timeseries',
  '/api/sites/{siteId}/pages',
  '/api/sites/{siteId}/referrers',
  '/api/sites/{siteId}/events',
  '/api/sites/{siteId}/entry-pages',
  '/api/sites/{siteId}/exit-pages',
  '/api/sites/{siteId}/realtime',
]

// The page_views breakdowns are registered through one shared helper.
const TOP_DIMENSIONS = [
  '/api/sites/{siteId}/countries',
  '/api/sites/{siteId}/devices',
  '/api/sites/{siteId}/browsers',
  '/api/sites/{siteId}/operating-systems',
  '/api/sites/{siteId}/utm/sources',
  '/api/sites/{siteId}/utm/mediums',
  '/api/sites/{siteId}/utm/campaigns',
]

describe('guardrail: site-scoped read endpoints require at least viewer', () => {
  // These were owner-gated until #19, which is why an invited colleague could not
  // read a single report. The requirement is now a RANK, and the rank has to be
  // named at the endpoint: `viewer` reads, `admin` also writes, `owner` alone
  // destroys. A read that asks for more than viewer silently un-shares the site.
  for (const path of READ_ENDPOINTS) {
    test(`GET ${path} enforces auth + at least viewer`, () => {
      const block = routeBlock(path)
      expect(block).not.toBe('')
      expect(block).toContain('requireSiteRole(request, siteId, \'viewer\')')
      expect(block).toContain('.middleware(\'auth\')')
    })
  }
})

describe('guardrail: top-dimension reports are owner-gated', () => {
  test('the topDimension helper enforces auth + site ownership', () => {
    const i = analytics.indexOf('function topDimension(')
    expect(i).toBeGreaterThan(-1)

    // Bounded by the helper's first registration rather than by a character
    // count. The window here was `i + 900`, which silently stopped covering
    // `.middleware('auth')` the moment the handler grew — a guard that reports a
    // missing gate because the function got longer is one people fix by raising
    // the number, and the next growth puts them back where they started.
    const end = analytics.indexOf('\ntopDimension(', i)
    expect(end, 'topDimension is never registered').toBeGreaterThan(i)

    const block = analytics.slice(i, end)
    expect(block).toContain('requireSiteRole(request, siteId, \'viewer\')')
    expect(block).toContain('.middleware(\'auth\')')
  })

  for (const path of TOP_DIMENSIONS) {
    test(`${path} is registered through the gated helper`, () => {
      expect(analytics).toContain(`topDimension('${path}'`)
    })
  }
})

// Erasure endpoints delete data, so they must be at least as gated as reads.
const DELETE_DECLS = [
  'route.delete(\'/api/sites/{siteId}/data\'',
  'route.delete(\'/api/sites/{siteId}/visitors/{visitorId}\'',
]

// Site management (rename/edit + cascade delete) mutates owner data too.
const MGMT_DECLS = [
  'route.patch(\'/api/sites/{siteId}\'',
  'route.delete(\'/api/sites/{siteId}\'',
]

function declBlock(decl: string): string {
  const i = analytics.indexOf(decl)
  expect(i).toBeGreaterThan(-1)
  const rest = analytics.slice(i)
  const end = rest.indexOf('\nroute.')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('guardrail: destroying data stays owner-only', () => {
  // An admin is someone trusted with reports and settings. Erasing a client's
  // history, or deleting the site outright, is not the same trust — and it is not
  // recoverable, so the rank here must never be relaxed to admin for convenience.
  for (const decl of DELETE_DECLS.concat(['route.delete(\'/api/sites/{siteId}\''])) {
    test(`${decl.slice(12)} enforces auth + owner`, () => {
      const block = declBlock(decl)
      expect(block).toContain('requireSiteOwner(request, siteId)')
      expect(block).toContain('.middleware(\'auth\')')
    })
  }
})

describe('guardrail: settings and sharing require admin', () => {
  // Writes a viewer must not be able to make. Sharing is here rather than with the
  // reads because a share link hands the data to anyone holding the URL.
  const ADMIN_DECLS = [
    'route.patch(\'/api/sites/{siteId}\'',
    'route.post(\'/api/sites/{siteId}/goals\'',
    'route.post(\'/api/sites/{siteId}/share\'',
    'route.delete(\'/api/sites/{siteId}/share\'',
    'route.post(\'/api/sites/{siteId}/members\'',
    'route.delete(\'/api/sites/{siteId}/members/{userId}\'',
  ]
  for (const decl of ADMIN_DECLS) {
    test(`${decl.slice(12)} enforces auth + admin`, () => {
      const block = declBlock(decl)
      expect(block).toContain('requireSiteRole(request, siteId, \'admin\')')
      expect(block).toContain('.middleware(\'auth\')')
    })
  }
})

describe('guardrail: no site-scoped endpoint is left ungated', () => {
  // The failure this exists to catch is a NEW endpoint added without a check —
  // the one way a site-scoped leak gets introduced now that ranks exist.
  //
  // The first version of this test counted gates against routes with a tolerance
  // for the topDimension helper, and a deliberately ungated endpoint added during
  // review slipped straight through: the slack absorbed exactly the case it was
  // meant to detect. It now inspects each route body, which cannot be satisfied by
  // arithmetic.
  const decls = [...analytics.matchAll(/^route\.(get|post|patch|put|delete)\('(\/api\/sites\/\{siteId\}[^']*)'/gm)]

  test('there are site-scoped routes to check, so this cannot pass vacuously', () => {
    expect(decls.length).toBeGreaterThan(15)
  })

  for (const m of decls) {
    const [decl, verb, path] = [m[0], m[1], m[2]]
    test(`${verb.toUpperCase()} ${path} resolves a role`, () => {
      const i = analytics.indexOf(decl)
      const rest = analytics.slice(i)
      const end = rest.indexOf('\nroute.')
      const block = end === -1 ? rest : rest.slice(0, end)
      expect(block).toMatch(/requireSiteRole\(request, siteId, '(viewer|admin|owner)'\)|requireSiteOwner\(request, siteId\)/)
    })
  }
})

/**
 * No model may generate its own REST API (#49).
 *
 * Every test above reads `routes/analytics.ts` and asserts a guard is PRESENT.
 * None of them can see whether it RUNS — and for one endpoint, it did not.
 *
 * `useApi` on a model makes the ORM generate CRUD at `/api/{uri}` from
 * `storage/framework/orm/routes.ts`. Site declared it with the same five paths
 * this file guards by hand, and the generated `PATCH /api/sites/{id}` took
 * precedence: site updates were broken outright for everyone, including the
 * owner, answering 400 "Invalid ID parameter" because the generated handler
 * coerces the id to a number and site ids here are strings. The guard in
 * `routes/analytics.ts` was correct, asserted by the tests above, and never
 * executed.
 *
 * The generated routes also apply no row scoping unless the model declares
 * `ownership` or carries a `team_id`, and reads are public unless the model opts
 * into middleware. `User` declared `useApi`, so `GET /api/users` returned every
 * name and email address in the database to an unauthenticated request.
 *
 * So this is not a style rule. A model quietly re-adding `useApi` can both
 * expose an unguarded surface and disable a guarded one, and nothing else in
 * this suite would notice. Routes belong in `routes/`, where the guard sits next
 * to the handler and the tests above can see it.
 */
describe('models do not generate routes', () => {
  const modelsDir = join(import.meta.dir, '../../app/Models')
  const models = readdirSync(modelsDir).filter(f => f.endsWith('.ts'))

  test('there are models to check, so this cannot pass vacuously', () => {
    expect(models.length).toBeGreaterThan(4)
  })

  for (const file of models) {
    test(`${file} declares no useApi`, () => {
      // Comments stripped: these models explain at length why they do NOT carry
      // the trait, and matching the explanation would fail a correct file.
      const code = readFileSync(join(modelsDir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect({ file, useApi: /\buseApi\b/.test(code) }).toEqual({ file, useApi: false })
    })
  }
})
