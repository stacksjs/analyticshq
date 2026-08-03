/**
 * Dashboard chart shapes, as AMBIENT declarations (rule 10b: shared types live in
 * types/ and are never imported).
 *
 * These describe the two functions that stayed inside dashboard.stx's <script server>
 * block because they close over request-scoped state -- `granularity` for densify, the
 * CHART constant for buildChart -- and so could not move to app/Support with the pure
 * formatters.
 *
 * Read the caveat honestly: tsc cannot see inside .stx, so these annotate the page for
 * a human and an editor and are verified by nothing. They are still worth writing, but
 * a wrong shape here is a real defect that no build step will catch. If one of these
 * functions grows enough to matter, move it to app/Support where it is checked.
 */

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

/** Everything the markup needs to draw the chart. Spreads the CHART box dimensions. */
interface ChartGeometry {
  pts: ChartPoint[]
  viewsLine: string
  visitorsLine: string
  area: string
  prevLine: string
  bottom: number
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
