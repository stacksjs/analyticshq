import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const component = readFileSync(join(ROOT, 'resources/components/DateRangePicker.stx'), 'utf8')
const dashboard = readFileSync(join(ROOT, 'resources/views/dashboard.stx'), 'utf8')

// The date math ships inside the component's client script, where a unit test
// cannot import it. The #region markers fence off the part that touches no
// runtime, and this evaluates exactly that text, so the tests run against the
// code the page runs rather than a copy of it.
const pureSlice = component.match(/\/\/ #region pure\n([\s\S]*?)\n\/\/ #endregion pure/)?.[1] ?? ''
interface PickCell { ymd: string, day: number, inMonth: boolean, future: boolean }
type PickSelection = { from: string, to: string } | { range: string }

/** The functions the region defines, as the component calls them. */
interface PickerMath {
  pickYmd: (y: number, m: number, d: number) => string
  pickParse: (s: string) => { y: number, m: number, d: number }
  pickShift: (s: string, days: number) => string
  pickShiftMonth: (ym: string, n: number) => string
  pickMonthOf: (s: string) => string
  pickGrid: (ym: string, todayYmd: string) => PickCell[]
  pickOrder: (a: string, b: string) => { from: string, to: string }
  pickPreset: (key: string, todayYmd: string) => PickSelection | null
  pickQuery: (search: string, sel: PickSelection) => string
}

// eslint-disable-next-line no-new-func
const pure: PickerMath = new Function(`${pureSlice}\nreturn { pickYmd, pickParse, pickShift, pickShiftMonth, pickMonthOf, pickGrid, pickOrder, pickPreset, pickQuery }`)()

describe('date range picker: calendar grid', () => {
  test('six weeks starting on the Sunday on or before the 1st', () => {
    const cells = pure.pickGrid('2026-06', '2026-09-16')
    expect(cells).toHaveLength(42)
    expect(cells[0].ymd).toBe('2026-05-31')
    expect(cells[0].inMonth).toBe(false)
    expect(cells.filter(c => c.inMonth)).toHaveLength(30)
    expect(cells.at(-1)!.ymd).toBe('2026-07-11')
  })

  test('a month that starts on Sunday still leads with its own 1st', () => {
    expect(pure.pickGrid('2026-03', '2026-09-16')[0].ymd).toBe('2026-03-01')
  })

  test('leap February and the December to January rollover', () => {
    expect(pure.pickGrid('2028-02', '2028-09-16').filter(c => c.inMonth)).toHaveLength(29)
    const dec = pure.pickGrid('2026-12', '2027-01-16')
    expect(dec.at(-1)!.ymd.startsWith('2027-01')).toBe(true)
  })

  test('days after today are marked future', () => {
    const cells = pure.pickGrid('2026-09', '2026-09-16')
    expect(cells.find(c => c.ymd === '2026-09-16')?.future).toBe(false)
    expect(cells.find(c => c.ymd === '2026-09-17')?.future).toBe(true)
  })
})

describe('date range picker: day arithmetic', () => {
  test('shifts across the US DST changes without losing or gaining a day', () => {
    expect(pure.pickShift('2026-03-08', 1)).toBe('2026-03-09')
    expect(pure.pickShift('2026-03-07', 1)).toBe('2026-03-08')
    expect(pure.pickShift('2026-11-01', 1)).toBe('2026-11-02')
    expect(pure.pickShift('2026-11-01', -1)).toBe('2026-10-31')
  })

  test('shifts across month and year boundaries', () => {
    expect(pure.pickShift('2026-01-01', -1)).toBe('2025-12-31')
    expect(pure.pickShiftMonth('2026-01', -1)).toBe('2025-12')
    expect(pure.pickShiftMonth('2026-12', 1)).toBe('2027-01')
  })

  test('orders a backwards pick', () => {
    expect(pure.pickOrder('2026-09-16', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-09-16' })
    expect(pure.pickOrder('2026-09-01', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-09-01' })
  })
})

describe('date range picker: presets', () => {
  const today = '2026-09-16'

  test('the spans the server already knows go out as ?range=', () => {
    for (const key of ['7d', '30d', '90d', '1y', 'all'])
      expect(pure.pickPreset(key, today)).toEqual({ range: key })
  })

  test('calendar presets resolve to local day bounds', () => {
    expect(pure.pickPreset('today', today)).toEqual({ from: '2026-09-16', to: '2026-09-16' })
    expect(pure.pickPreset('yesterday', today)).toEqual({ from: '2026-09-15', to: '2026-09-15' })
    expect(pure.pickPreset('this-month', today)).toEqual({ from: '2026-09-01', to: '2026-09-16' })
    expect(pure.pickPreset('last-month', today)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(pure.pickPreset('this-year', today)).toEqual({ from: '2026-01-01', to: '2026-09-16' })
    expect(pure.pickPreset('last-year', today)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
  })

  test('last month on the 1st of January is December of the previous year', () => {
    expect(pure.pickPreset('last-month', '2027-01-01')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(pure.pickPreset('yesterday', '2027-01-01')).toEqual({ from: '2026-12-31', to: '2026-12-31' })
  })

  test('an unknown preset is refused rather than guessed', () => {
    expect(pure.pickPreset('fortnight', today)).toBeNull()
  })
})

describe('date range picker: the URL it writes', () => {
  test('a custom range replaces the preset and keeps site, filters and compare', () => {
    const next = new URLSearchParams(pure.pickQuery('?site=demo&range=1y&compare=1&country=US', { from: '2026-09-01', to: '2026-09-16' }))
    expect(next.get('site')).toBe('demo')
    expect(next.get('compare')).toBe('1')
    expect(next.get('country')).toBe('US')
    expect(next.get('from')).toBe('2026-09-01')
    expect(next.get('to')).toBe('2026-09-16')
    // The server ignores ?from/?to while ?range=all is present, so it must go.
    expect(next.has('range')).toBe(false)
  })

  test('a preset replaces a custom range', () => {
    const next = new URLSearchParams(pure.pickQuery('?site=demo&from=2026-09-01&to=2026-09-16', { range: '30d' }))
    expect(next.get('range')).toBe('30d')
    expect(next.has('from')).toBe(false)
    expect(next.has('to')).toBe(false)
  })
})

describe('date range picker: wiring', () => {
  test('the dashboard mounts the picker and no longer ships native date inputs', () => {
    expect(dashboard).toContain('<DateRangePicker :summary="rangeLabel" :active="isCustom" />')
    expect(dashboard).not.toContain('type="date"')
  })

  test('an open panel is dismissed by a click outside it', () => {
    // A native <details> has no outside-click close, so the component adds a
    // transparent full-viewport backdrop behind the panel that closes it.
    expect(component).toContain('<div class="drp-backdrop" @click="pickClose"')
    expect(component).toMatch(/function pickClose\(e\) \{[\s\S]*?closest\('details'\)[\s\S]*?removeAttribute\('open'\)/)
    // It sits below the panel and above the sticky nav so a click on the panel
    // itself never reaches it, but a click on the page behind does.
    const backdrop = dashboard.match(/\.drp-backdrop\s*\{[^}]*\}/)?.[0] ?? ''
    expect(backdrop).toContain('position: fixed')
    expect(backdrop).toContain('inset: 0')
    expect(backdrop).toMatch(/z-index:\s*39\b/)
  })

  test('at phone width the panel shows one calendar inside the visible viewport', () => {
    // Anchored on the rule that already switches the menu to phone layout, so the
    // test does not depend on the block's breakpoint value.
    const phone = dashboard.slice(dashboard.indexOf('.date-menu { position: static; }'))
    expect(phone).toContain('.drp-cal.is-right { display: none; }')
    expect(phone).toContain('max-height: calc(100dvh - 6rem); overflow-y: auto; overscroll-behavior: contain;')
    expect(phone).toContain('.drp { grid-template-columns: minmax(0, 1fr); }')
  })
})
