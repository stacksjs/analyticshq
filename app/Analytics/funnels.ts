/**
 * Multi-step funnels, aggregate only (#21).
 *
 * ## What this can see, and what nobody can
 *
 * A funnel asks whether the same person reached step 2 after step 1, so it needs
 * an identity that survives between steps. This product has two, and both are
 * deliberately short-lived:
 *
 *   `session_id`   one visit
 *   `visitor_id`   sha256(ip | ua | site | secret salt), where the salt is
 *                  random, per site, per UTC day, and deleted at retention
 *
 * So a funnel spanning more than a day is not something this declines to
 * compute — it is something the data cannot express, for us as much as for
 * anyone. Once a day's salt is deleted its hashes are unlinkable to any input
 * permanently. A 30-day funnel is the sum of 30 one-day funnels, and a visitor
 * who lands at 23:50 and converts at 00:10 is two people. That is a real
 * limitation and it is reported in the response rather than hidden, because a
 * number that quietly means something narrower than the reader assumes is worse
 * than no number.
 *
 * ## Aggregate means aggregate
 *
 * Nothing here returns, logs, or can be made to return a per-person path. The
 * query counts identities per step and discards them; the only values that leave
 * this module are integers. That is the constraint the issue asked for, and it is
 * enforced by the shape of the SQL rather than by remembering not to select the
 * wrong column — there is no code path that carries an identity out.
 *
 * ## Why steps are goals
 *
 * `/collect` already matches goals on the hot path and writes a conversion row.
 * Reusing them means a funnel and the goal report can never disagree about
 * whether something happened. Matching raw paths here instead would be a second
 * opinion, and second opinions drift.
 *
 * Because conversions are written with a deterministic id — sha256(session|goal)
 * with ON CONFLICT DO NOTHING — there is exactly one row per session per goal,
 * holding the FIRST time it happened. That is what makes the step ordering below
 * a plain timestamp comparison rather than a search for "the earliest occurrence
 * after the previous step": later occurrences were never recorded.
 */

import { db } from '@stacksjs/database'

export type FunnelScope = 'session' | 'day'

export const FUNNEL_SCOPES: readonly FunnelScope[] = ['session', 'day'] as const

/** Fewer than two steps is not a funnel; more than eight is a report nobody reads. */
export const MIN_STEPS = 2
export const MAX_STEPS = 8

export function isFunnelScope(v: unknown): v is FunnelScope {
  return typeof v === 'string' && (FUNNEL_SCOPES as readonly string[]).includes(v)
}

export interface FunnelStepResult {
  goalId: string
  name: string
  /** Identities reaching this step, having reached every step before it in order. */
  count: number
  /** Percentage of step 1 still here. 100 for step 1 by definition. */
  fromStart: number
  /** Percentage of the PREVIOUS step still here — where the leak actually is. */
  fromPrevious: number
  /** How many were lost between the previous step and this one. */
  droppedOff: number
}

export interface FunnelResult {
  scope: FunnelScope
  from: string
  to: string
  steps: FunnelStepResult[]
  /**
   * True when the range covers more than one UTC day and the scope is `day`, so
   * the reader knows the identity resets at midnight and the total is a sum of
   * days rather than a single journey.
   */
  spansMultipleDays: boolean
}

/**
 * Validate a step list.
 *
 * Repeats are rejected rather than tolerated: with one conversion row per session
 * per goal, a funnel naming the same goal twice can never advance past the
 * repeat, so it would render as a guaranteed 100% drop-off — a broken report that
 * looks like a finding.
 */
export function validateSteps(value: unknown): { error: string } | { steps: string[] } {
  if (!Array.isArray(value))
    return { error: 'steps must be an array of goal ids' }
  if (value.length < MIN_STEPS)
    return { error: `a funnel needs at least ${MIN_STEPS} steps` }
  if (value.length > MAX_STEPS)
    return { error: `a funnel can have at most ${MAX_STEPS} steps` }

  const steps: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim())
      return { error: 'each step must be a goal id' }
    steps.push(entry.trim())
  }
  if (new Set(steps).size !== steps.length)
    return { error: 'a funnel cannot use the same goal twice' }

  return { steps }
}

/** Parse the stored column, tolerating anything malformed as "no steps". */
export function parseSteps(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : []
  }
  catch {
    return []
  }
}

/**
 * Build the funnel query for a given number of steps.
 *
 * One CTE per step, each joined to the previous one and required to have happened
 * at or after it. `>=` rather than `>` is deliberate: one beacon can satisfy two
 * goals at once (a pageview matching both "visited /pricing" and "visited any
 * page"), and those rows carry the identical timestamp. With `>` such a funnel
 * would report a 100% drop at step 2 despite both steps genuinely being reached.
 *
 * Exported so the test can read the generated SQL rather than trust a description
 * of it. Parameters: $1 site, $2 from, $3 to, then one per goal id.
 */
export function buildFunnelSql(stepCount: number, scope: FunnelScope): string {
  // The identity expression, and the reason each is safe to interpolate: both are
  // literals chosen by a union type, never a caller's string.
  const ident = scope === 'day'
    // A visitor hash is only meaningful within its own UTC day — the salt behind
    // it is rotated daily — so the day is part of the identity, not an accident.
    ? `visitor_id || '|' || SUBSTRING(timestamp FROM 1 FOR 10)`
    : `session_id`

  const goalParam = (i: number) => `$${4 + i}`
  const goalList = Array.from({ length: stepCount }, (_, i) => goalParam(i)).join(', ')

  const ctes: string[] = [
    `ev AS (
       SELECT ${ident} AS ident, goal_id, MIN(timestamp) AS at
       FROM conversions
       WHERE site_id = $1 AND timestamp >= $2 AND timestamp <= $3
         AND goal_id IN (${goalList})
         AND ${scope === 'day' ? 'visitor_id' : 'session_id'} IS NOT NULL
       GROUP BY ident, goal_id
     )`,
    `s0 AS (SELECT ident, at FROM ev WHERE goal_id = ${goalParam(0)})`,
  ]

  for (let i = 1; i < stepCount; i++) {
    ctes.push(
      `s${i} AS (
         SELECT e.ident, MIN(e.at) AS at
         FROM ev e JOIN s${i - 1} p ON p.ident = e.ident
         WHERE e.goal_id = ${goalParam(i)} AND e.at >= p.at
         GROUP BY e.ident
       )`,
    )
  }

  // Counts only. No identity leaves this query, which is what makes the result
  // aggregate by construction rather than by convention.
  const counts = Array.from({ length: stepCount }, (_, i) => `(SELECT COUNT(*) FROM s${i}) AS c${i}`).join(', ')

  return `WITH ${ctes.join(',\n')} SELECT ${counts}`
}

/**
 * Run a funnel and shape the result.
 *
 * `names` maps goal id to label; a step whose goal has been deleted still renders,
 * as "(deleted goal)" with a count of zero, rather than vanishing and silently
 * renumbering every step after it.
 */
export async function computeFunnel(
  siteId: string,
  goalIds: string[],
  scope: FunnelScope,
  from: Date,
  to: Date,
  names: Record<string, string> = {},
): Promise<FunnelResult> {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()

  const sql = buildFunnelSql(goalIds.length, scope)
  const rows = await db.unsafe(sql, [siteId, fromIso, toIso, ...goalIds]).catch(() => []) as Array<Record<string, string>>
  const row = rows?.[0] ?? {}

  const counts = goalIds.map((_, i) => Number(row[`c${i}`] ?? 0))
  const first = counts[0] ?? 0

  const steps: FunnelStepResult[] = goalIds.map((goalId, i) => {
    const count = counts[i] ?? 0
    const previous = i === 0 ? count : (counts[i - 1] ?? 0)
    return {
      goalId,
      name: names[goalId] ?? '(deleted goal)',
      count,
      // Guarded rather than computed blind: a funnel whose first step has no data
      // would otherwise divide by zero and report NaN through the API.
      fromStart: first ? Math.round((count / first) * 100) : 0,
      fromPrevious: previous ? Math.round((count / previous) * 100) : 0,
      droppedOff: Math.max(0, previous - count),
    }
  })

  return {
    scope,
    from: fromIso,
    to: toIso,
    steps,
    spansMultipleDays: scope === 'day' && fromIso.slice(0, 10) !== toIso.slice(0, 10),
  }
}
