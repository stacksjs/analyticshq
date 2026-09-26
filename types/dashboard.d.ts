/**
 * Dashboard shapes, as AMBIENT declarations (rule 10b: shared types live in
 * types/ and are never imported).
 *
 * dashboard.stx's <script server> block reads raw rows from Postgres and maps each
 * one into the row types below as it arrives, so everything downstream of a query --
 * the panels, the CSV payload, the chart -- is checked against a real shape rather
 * than against `any`. The chart types describe the two functions that stayed inside
 * that block because they close over request-scoped state (`granularity` for
 * densify, the CHART constant for buildChart).
 *
 * Checked by `bun run typecheck:views`, which hands this file to `stx typecheck`
 * with `--lib`. tsc alone still cannot see inside a .stx file, so that script is
 * the only thing verifying the templates against these shapes.
 *
 * The row shapes are `type` aliases rather than interfaces on purpose: an object
 * type alias is assignable to an index signature and an interface is not, and
 * BreakdownPanel reads any of them through `row[labelKey]`.
 */

/**
 * One grouped count per referrer source, as the Top sources panel and the channel
 * fold read it. `source` is null for the NULL group (a visit with no referrer
 * source recorded), which the panel renders as an empty label.
 */
type SourceRow = { source: string | null, views: number }
/** Top pages, with the entry-based bounce the panel shows beside each path. */
type PageRow = { path: string | null, views: number, visitors: number, entries: number, bounces: number }
/** Top referrers: the full referring URL rather than the normalized source. */
type ReferrerUrlRow = { url: string | null, views: number, visitors: number }
type CampaignRow = { campaign: string | null, views: number }
type MediumRow = { medium: string | null, views: number }
type ContentRow = { content: string | null, views: number }
type TermRow = { term: string | null, views: number }
type CountryRow = { country: string | null, views: number }
type DeviceRow = { device: string | null, views: number }
type BrowserRow = { browser: string | null, views: number }
type OsRow = { os: string | null, views: number }
/** One active goal and its conversions in range (LEFT JOIN, so zero rows read 0). */
type GoalRow = { id: string | null, name: string | null, goal_value: number, conversions: number, converters: number, total_value: number }
type EventRow = { name: string | null, events: number, visitors: number }
/** An Outbound Link or File Download event, grouped by the URL its properties carry. */
type LinkRow = { url: string, clicks: number, visitors: number }
type EntryPageRow = { path: string | null, entries: number, visitors: number, bounces: number }
type ExitPageRow = { path: string | null, exits: number, visitors: number }
/** One Search Console query. `position` is null when it had no impressions. */
type SearchQueryRow = { query: string | null, clicks: number, impressions: number, position: number | null }
/** A pending invitation on the Team panel. */
type InviteListRow = { id: string | null, email: string | null, role: string | null, expires_at: string | null }
/** The active site when it is not one of the caller's own (a share-link view). */
type SiteRecord = { id: string, name: string | null, domains: unknown, role?: string, owner_email?: string | null }

/** One timeseries bucket as the query returns it, before densify fills the gaps. */
type SeriesRow = { day: string, views: number, visitors: number }

/** One timeseries bucket, as densify emits it and buildChart consumes it. */
interface ChartRow {
  /** Raw bucket key: 'YYYY-MM-DD', 'YYYY-MM-DDTHH' hourly, or 'YYYY-MM' monthly. */
  day: string
  /** Display form: 'MM-DD HH:00' hourly, otherwise the same as `day`. */
  label: string
  views: number
  visitors: number
}

/** A plotted point: the bucket plus its geometry inside the 1000x200 viewBox. */
interface ChartPoint extends ChartRow {
  /** Same bucket one period earlier, aligned by index; null when there is no baseline. */
  prevViews: number | null
  x: number
  /** y for the views line. */
  vy: number
  /** y for the visitors line. */
  uy: number
  viewsTopPct: number
  visTopPct: number
}

/** A date along the x axis. The first and last hug the plot edges instead of centring past them. */
interface ChartXTick {
  label: string
  leftPct: number
  anchor: 'start' | 'mid' | 'end'
}

/** Everything the markup needs to draw the chart. Spreads the CHART box dimensions. */
interface ChartGeometry {
  pts: ChartPoint[]
  viewsLine: string
  visitorsLine: string
  area: string
  prevLine: string
  bottom: number
  /** Gridlines: a round value, its label, and its height as a % of the plot box. */
  yAxis: Array<{ value: number, label: string, topPct: number }>
  /** Five dates along the bottom. */
  xAxis: ChartXTick[]
  firstDay?: string
  lastDay?: string
  firstLabel?: string
  lastLabel?: string
  w: number
  h: number
  padX: number
  padT: number
  padB: number
}

/**
 * What POST /api/sites/{id}/import/fathom answers with, in every case the
 * dashboard reads: a dry-run preview, a finished import, a 413 asking for date
 * windows, or an error. Each field is present only in the cases that send it.
 */
interface FathomImportBody {
  error?: string
  preview?: { priorImport?: boolean, read?: string[], paths?: number, visitors?: number, pageViews?: number }
  range?: { from: string, to: string }
  warnings?: string[]
  imported?: { pageViews?: number, sessions?: number }
  estimate?: { pageViews?: number }
  maxRows?: number
}

/** One request to that endpoint, as the dashboard's postFathom reports it. */
interface FathomReply {
  ok: boolean
  status: number
  data: FathomImportBody
}

/**
 * What a host may inject as `preloaded` to render the dashboard without the view
 * querying Postgres itself (see types/render-context.d.ts). Every field is
 * optional: dashboard.stx falls back to its own empty value for each one missing.
 */
interface DashboardPreload {
  kpis?: { views: number, visitors: number, sessions: number }
  series?: SeriesRow[]
  prevSeries?: SeriesRow[]
  pages?: PageRow[]
  referrers?: SourceRow[]
  referrerUrls?: ReferrerUrlRow[]
  channelRows?: SourceRow[]
  campaigns?: CampaignRow[]
  utmSources?: SourceRow[]
  utmMediums?: MediumRow[]
  utmContents?: ContentRow[]
  utmTerms?: TermRow[]
  countries?: CountryRow[]
  devices?: DeviceRow[]
  browsers?: BrowserRow[]
  systems?: OsRow[]
  bounceRate?: number
  avgDuration?: number
  prevViews?: number
  prevVisitors?: number
  prevSessions?: number
  prevBounce?: number
  prevAvgDuration?: number
  liveNow?: number
  goals?: GoalRow[]
  events?: EventRow[]
  outboundLinks?: LinkRow[]
  fileDownloads?: LinkRow[]
  entryPages?: EntryPageRow[]
  exitPages?: ExitPageRow[]
  vitals?: import('../app/Analytics/vitals').VitalReport[]
  vitalsByDevice?: import('../app/Analytics/vitals').VitalDeviceRow[]
  searchQueries?: SearchQueryRow[]
}
