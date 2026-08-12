/**
 * The embeddable stats badge (#26).
 *
 * An SVG served to an `<img>` tag on somebody else's page. That shapes every
 * decision here:
 *
 * - It is **self-contained**. No external font, no stylesheet, no script. An
 *   `<img>` will not run them anyway, and a badge that depends on a CDN is a
 *   badge that breaks silently on a page we do not control.
 * - Everything rendered is either a number we computed or a label we sanitised.
 *   SVG is XML and an unescaped `&` or `<` produces a broken image rather than a
 *   parse error anyone will see, so the label goes through a strict allowlist
 *   rather than an escape function — see `sanitizeLabel`.
 * - Text width is estimated rather than measured, because there is no font metric
 *   available server-side. The estimate is deliberately generous: too wide is a
 *   little ugly, too narrow clips the number, and a clipped number is wrong data.
 */

/** Roughly the advance width of one character at 11px in a normal sans face. */
const CHAR_WIDTH = 7
const PADDING = 10

/**
 * Compact a count for a small badge: 1234 becomes "1.2k".
 *
 * Rounds toward zero rather than nearest, so a badge never claims a milestone the
 * site has not reached — "1M visitors" at 999,999 is the kind of small lie that
 * gets screenshotted.
 */
export function formatCount(n: number): string {
  const value = Math.max(0, Math.trunc(n))
  if (value < 1000)
    return String(value)
  if (value < 1_000_000) {
    const k = Math.trunc(value / 100) / 10
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
  }
  const m = Math.trunc(value / 100_000) / 10
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
}

/**
 * Reduce a caller-supplied label to something that cannot break the document.
 *
 * An allowlist, not an escape: the label ends up inside SVG text served
 * cross-origin, and the set of things that are safe there is small and easy to
 * state, where the set of things that need escaping is neither. Anything outside
 * letters, digits, spaces and a few separators is dropped.
 */
export function sanitizeLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string')
    return fallback
  const cleaned = raw.replace(/[^\w \-.]/g, '').trim().slice(0, 24)
  return cleaned || fallback
}

export interface BadgeOptions {
  label: string
  value: string
  /** Right-hand background. */
  color?: string
}

/**
 * Render the badge.
 *
 * `role="img"` and `aria-label` are not decoration: this is loaded as an image on
 * pages we do not control, and a bare SVG announces nothing useful to a screen
 * reader. The label carries the whole meaning of the badge.
 */
export function renderBadge(options: BadgeOptions): string {
  const label = sanitizeLabel(options.label, 'visitors')
  const value = sanitizeLabel(options.value, '0')
  const color = /^#[0-9a-f]{6}$/i.test(options.color ?? '') ? options.color as string : '#46d3c0'

  const labelWidth = label.length * CHAR_WIDTH + PADDING * 2
  const valueWidth = value.length * CHAR_WIDTH + PADDING * 2
  const total = labelWidth + valueWidth

  // Text is placed at 10x scale and scaled down, the trick shields.io uses to get
  // sub-pixel positioning without fractional coordinates in the markup.
  const labelCentre = (labelWidth / 2) * 10
  const valueCentre = (labelWidth + valueWidth / 2) * 10

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${value}">`
    + `<title>${label}: ${value}</title>`
    + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
    + `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)">`
    + `<rect width="${labelWidth}" height="20" fill="#2b2b2b"/>`
    + `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>`
    + `<rect width="${total}" height="20" fill="url(#s)"/>`
    + `</g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110" transform="scale(.1)">`
    + `<text x="${labelCentre}" y="145" fill="#010101" fill-opacity=".3">${label}</text>`
    + `<text x="${labelCentre}" y="140">${label}</text>`
    + `<text x="${valueCentre}" y="145" fill="#010101" fill-opacity=".3">${value}</text>`
    + `<text x="${valueCentre}" y="140" fill="#04201c">${value}</text>`
    + `</g></svg>`
}

/**
 * A sparkline for the mini time-series widget.
 *
 * Returns an SVG polyline scaled to the series' own maximum, so a quiet site and
 * a busy one both fill the box — the shape is the information, and a shared
 * absolute scale would flatten every small site into a straight line.
 *
 * An empty or all-zero series renders a flat baseline rather than dividing by
 * zero and emitting `NaN` coordinates, which browsers drop silently and which
 * would look like a rendering bug rather than an absence of data.
 */
export function renderSparkline(values: number[], width = 200, height = 40): string {
  const series = values.length ? values : [0]
  const max = Math.max(...series, 0)
  const step = series.length > 1 ? width / (series.length - 1) : width

  const points = series.map((v, i) => {
    const x = (i * step).toFixed(1)
    // Inverted: SVG y grows downward, and a chart that grows downward is wrong.
    const y = max > 0 ? (height - (v / max) * height).toFixed(1) : (height / 2).toFixed(1)
    return `${x},${y}`
  }).join(' ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Visitors over time">`
    + `<polyline fill="none" stroke="#46d3c0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${points}"/>`
    + `</svg>`
}
