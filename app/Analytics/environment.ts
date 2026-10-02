/**
 * The deployment environment a beacon came from (#60).
 *
 * The tracker reads `data-environment` off its own script tag and sends it as
 * the top-level `environment` key on every pageview, custom event and Web
 * Vitals beacon. It is metadata only: whether a site reports at all is decided
 * before the snippet is ever injected (Stacks gates it on APP_ENV), never here
 * and never in the tracker.
 *
 * /collect is public and the value is whatever a page put in an attribute, so
 * it is normalized here, at the boundary, before it reaches a column. A short
 * label survives, lowercased and trimmed. Anything else is DROPPED, not
 * rejected: a typo in an optional attribute must not cost the site its
 * pageview, the same rule event-properties.ts follows for optional metadata.
 */

/** Trimmed and lowercased first, then: a letter or digit, up to 31 more of `[a-z0-9_.-]`. */
export const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/

/** The column width. Matches the pattern's upper bound, so nothing is ever truncated. */
export const MAX_ENVIRONMENT_LENGTH = 32

/**
 * `staging`, `production`, `preview-42`... or null for an absent or unusable
 * value. Non-strings are refused outright rather than coerced: `String({})`
 * would otherwise store `[object object]`.
 */
export function normalizeEnvironment(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const label = value.trim().toLowerCase()
  return ENVIRONMENT_PATTERN.test(label) ? label : null
}
