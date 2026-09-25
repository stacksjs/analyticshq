/**
 * The dashboard's top section: header, live strip, period controls and chart.
 *
 * The header used to carry seven controls (site picker, a live pill, New site,
 * a settings gear, a theme toggle, Account, Log out) and Site settings had two
 * entry points, the gear and its own row between the numbers and the chart. The
 * chart opened on a year, so a new site's traffic was a flat line for two thirds
 * of it, with only the first and last dates under it and no scale at all. These
 * tests pin the reorganised version so it does not drift back.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveLocations } from '../../app/Analytics/live'
import { axisLabel, compactCount, niceCeil, xTicks, yTicks } from '../../app/Support/chart-axis'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const view = read('resources/views/dashboard.stx')
const picker = read('resources/components/DateRangePicker.stx')
const routes = read('routes/analytics.ts')

/** The template part of the view, after the style block, so CSS names do not count. */
const template = view.slice(view.indexOf("@section('content')"))
// Template comments stripped: they explain what used to be here, by name.
const header = template.slice(template.indexOf('<header'), template.indexOf('</header>')).replace(/\{\{--[\s\S]*?--\}\}/g, '')

describe('default period', () => {
  test('a bare /dashboard opens on 90 days', () => {
    expect(view).toContain("const DEFAULT_RANGE = '90d'")
    expect(view).toContain('queryParams.range || DEFAULT_RANGE')
  })

  test('the date picker marks the same preset active', () => {
    // Two spellings of the default drifted once already: the page showed one
    // period while the picker highlighted another.
    expect(picker).toContain("(pickUrlRange || '90d') === p.range")
    expect(picker).not.toContain("|| '1y'")
  })
})

describe('header', () => {
  test('person-level actions live in one account menu', () => {
    const menu = header.slice(header.indexOf('<details class="account-menu"'), header.indexOf('</details>'))
    for (const item of ['Site settings', 'Add a site', 'Account', 'Log out', '@click="toggleTheme"'])
      expect({ item, inMenu: menu.includes(item) }).toEqual({ item, inMenu: true })
  })

  test('none of them are loose buttons in the header any more', () => {
    const outsideMenu = header.replace(/<details class="account-menu"[\s\S]*?<\/details>/, '')
    for (const loose of ['Log out', 'New site', 'chrome-btn', 'i-hugeicons-settings-02', 'live-status'])
      expect({ loose, present: outsideMenu.includes(loose) }).toEqual({ loose, present: false })
  })

  test('the menu closes on a click elsewhere and on Escape', () => {
    expect(header).toContain('@keydown="closeMenuOnEscape"')
    expect(header).toMatch(/class="drp-backdrop" @click="closeMenu"/)
    expect(view).toContain('function closeMenu(')
    expect(view).toContain('function closeMenuOnEscape(')
  })

  test('Export is one icon button with an accessible name', () => {
    expect(header).toMatch(/@click="exportCsv"[^>]*aria-label="Export this report as CSV"/)
  })
})

describe('site settings has one home', () => {
  test('the section sits after the reports, just above the footer', () => {
    const settingsAt = template.indexOf('<details id="site-settings"')
    expect(settingsAt).toBeGreaterThan(template.indexOf('Traffic over time'))
    expect(settingsAt).toBeGreaterThan(template.indexOf('Top pages'))
    expect(settingsAt).toBeLessThan(template.indexOf('<footer'))
  })

  test('the menu link opens it rather than just scrolling to it', () => {
    expect(header).toContain('&settings=open#site-settings')
    expect(view).toContain("const settingsOpen = queryParams.settings === 'open'")
    expect(template).toMatch(/<details id="site-settings"[^>]*\{\{ settingsOpen \|\| !kpis\.views \? 'open' : '' \}\}>/)
  })

  test('every settings panel still follows the section toggle', () => {
    // The panels are shown by `details[open] ~ .site-settings-panel`, so they have
    // to stay siblings AFTER the <details>. Moving the block must not split them.
    const settingsAt = template.indexOf('<details id="site-settings"')
    const panels = [...template.matchAll(/site-settings-panel/g)].map(m => m.index!)
    expect(panels.length).toBeGreaterThanOrEqual(7)
    for (const at of panels)
      expect(at).toBeGreaterThan(settingsAt)
  })
})

describe('live now', () => {
  test('the strip is under the header, with places from the stream', () => {
    const stripAt = template.indexOf('id="live-now"')
    expect(stripAt).toBeGreaterThan(template.indexOf('</header>'))
    expect(stripAt).toBeLessThan(template.indexOf('aria-label="Key metrics"'))
    expect(template).toContain('x-for="loc in liveSpots().locations"')
    expect(view).toContain('liveSpots.set(d.where)')
  })

  test('the render, the stream and the poll send one snapshot', () => {
    // Three ways to read "who is here now", one function behind all of them,
    // so the first push after load cannot change what the page just drew.
    expect(view).toContain('const live = await liveSnapshot(String(siteId))')
    expect(routes).toContain('return json(await sharedSnapshot(String(siteId)))')
    expect(routes).toContain('return openLiveStream(String(siteId))')
  })

  test('the live count is site-wide, whatever the filters', () => {
    const block = view.slice(view.indexOf('const live = await liveSnapshot('), view.indexOf('liveCountries = live.countries'))
    expect(block).not.toContain('filterSql')
  })
})

describe('liveLocations', () => {
  const rows = [
    { country: 'US', region: 'US-CA', city: 'US-CA:San Diego', visitors: 3 },
    { country: 'US', region: 'US-CA', city: 'US-CA:Los Angeles', visitors: 1 },
    { country: 'DE', region: 'DE-BE', city: 'DE-BE:Berlin', visitors: 1 },
    { country: 'GB', region: null, city: null, visitors: 2 },
  ]

  test('a floor of 0 names every city', () => {
    const out = liveLocations(rows, 0, 7)
    expect(out.locations.map(l => l.label)).toEqual(['San Diego, CA', 'United Kingdom', 'Berlin', 'Los Angeles, CA'])
    expect(out.locations[0].flag).toBe('🇺🇸')
    expect(out.unknown).toBe(0)
  })

  test('under the floor a city rolls up into its country, never disappears', () => {
    const out = liveLocations(rows, 3, 7)
    // San Diego clears 3 and keeps its name; Los Angeles folds into the US row.
    expect(out.locations.map(l => [l.label, l.visitors])).toEqual([
      ['San Diego, CA', 3],
      ['United Kingdom', 2],
      ['Germany', 1],
      ['United States', 1],
    ])
    expect(out.locations.reduce((n, l) => n + l.visitors, 0)).toBe(7)
  })

  test('visitors with no country are counted as unknown, so the strip adds up', () => {
    const out = liveLocations(rows, 0, 10)
    expect(out.unknown).toBe(3)
  })

  test('places past the limit are summed, not dropped', () => {
    const out = liveLocations(rows, 0, 7, 2)
    expect(out.locations.length).toBe(2)
    expect(out.more).toBe(2)
  })

  test('junk country codes are ignored rather than flagged', () => {
    const out = liveLocations([{ country: 'XYZ', region: null, city: null, visitors: 1 }], 0, 1)
    expect(out.locations).toEqual([])
    expect(out.unknown).toBe(1)
  })
})

describe('chart axes', () => {
  test('the y scale tops out at a round number', () => {
    expect([1, 7, 43, 86, 101, 240, 999, 1200].map(niceCeil)).toEqual([1, 10, 50, 100, 200, 250, 1000, 2000])
    expect(niceCeil(0)).toBe(1)
    expect(yTicks(100).map(t => t.label)).toEqual(['100', '50', '0'])
  })

  test('counts are compact', () => {
    expect(compactCount(950)).toBe('950')
    expect(compactCount(1200)).toBe('1.2k')
    expect(compactCount(25_000)).toBe('25k')
    expect(compactCount(1_500_000)).toBe('1.5M')
  })

  test('dates read as dates, per granularity, with no timezone drift', () => {
    expect(axisLabel('2026-09-05')).toBe('Sep 5')
    expect(axisLabel('2026-09-05T14')).toBe('14:00')
    expect(axisLabel('2026-09')).toBe('Sep 2026')
  })

  test('five ticks, first and last included, centred on their columns', () => {
    const keys = Array.from({ length: 91 }, (_, i) => `2026-06-${String(i).padStart(2, '0')}`)
    const ticks = xTicks(keys, 5)
    expect(ticks.length).toBe(5)
    expect(ticks[0].leftPct).toBeCloseTo((0.5 / 91) * 100)
    expect(ticks[4].leftPct).toBeCloseTo((90.5 / 91) * 100)
    expect(xTicks(['2026-01-01'], 5).length).toBe(1)
    expect(xTicks([], 5)).toEqual([])
  })

  test('the chart draws them, and the header carries the period totals', () => {
    expect(template).toContain('@foreach (chart.yAxis as t)')
    expect(template).toContain('@foreach (chart.xAxis as t)')
    expect(template).toMatch(/chart-sum[\s\S]{0,120}kpis\.views\.toLocaleString\(\)/)
  })
})
