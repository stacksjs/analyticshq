/**
 * /password/forgot must not reveal whether an account exists (#34).
 *
 * The endpoint is unauthenticated and takes an arbitrary address, so any
 * observable difference between "known" and "unknown" turns it into a membership
 * test against our whole user table. Before the override in
 * app/Actions/Password/SendPasswordResetEmailAction.ts, the running API answered:
 *
 *   known address    -> 500 "Failed to send password reset email. Please try again later."
 *   unknown address  -> 404 "No account found with this email address."
 *
 * and now answers 200 with one identical body for both.
 *
 * These are source assertions rather than live requests because the property has
 * to hold on a fresh checkout with no server, no database and no mailer. They are
 * written against the ways the leak actually comes back — an early return for a
 * missing user, a second message string, or a 5xx when mail dispatch fails —
 * rather than against the current text, so rewording the message stays green and
 * reintroducing a branch does not.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const ACTION = 'app/Actions/Password/SendPasswordResetEmailAction.ts'

const src = existsSync(join(ROOT, ACTION)) ? readFileSync(join(ROOT, ACTION), 'utf8') : ''

/** Source with comments stripped — the comments quote the old leaky strings. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** The body of `handle`, which is where a leak would live. */
function handleBody(): string {
  const start = code.indexOf('async handle(')
  return start === -1 ? '' : code.slice(start)
}

describe('the app owns this endpoint rather than inheriting it', () => {
  test('the override exists', () => {
    // routes/auth.ts resolves 'Actions/Password/SendPasswordResetEmailAction'.
    // Without this file that name resolves to the vendored framework copy under
    // storage/framework/defaults — gitignored, unsynced by `bun install`, and
    // last written 2026-07-23 with the pre-fix version of this action.
    expect(existsSync(join(ROOT, ACTION))).toBe(true)
    expect(code.length).toBeGreaterThan(200)
  })

  test('the route still points at the name this file provides', () => {
    const routes = readFileSync(join(ROOT, 'routes/auth.ts'), 'utf8')
    expect(routes).toContain('Actions/Password/SendPasswordResetEmailAction')
  })
})

describe('every path answers the same thing', () => {
  test('there is exactly one response message, held in a constant', () => {
    // Two string literals means two branches means a tell.
    const messages = [...code.matchAll(/response\.success\(([^)]*)\)/g)].map(m => m[1].trim())
    expect(messages.length).toBeGreaterThan(0)
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toBe('NEUTRAL_RESPONSE')
  })

  test('a missing user does not get its own answer', () => {
    // The regression is `if (!user) return response.error(..., 404)`.
    expect(handleBody()).not.toMatch(/if\s*\(\s*!\s*user\s*\)/)
    expect(code).not.toMatch(/No account found/)
    expect(code).not.toMatch(/\b404\b/)
  })

  test('a mail dispatch failure is logged, not returned', () => {
    // Returning 5xx here re-opens the oracle whenever the mailer is degraded:
    // an unknown address never reaches dispatch, so it can never 5xx. That is
    // precisely the 500-vs-404 split this replaced.
    const catchBlock = code.slice(code.indexOf('catch'), code.indexOf('return response.success'))
    expect(catchBlock).toContain('log.error')
    expect(catchBlock).not.toContain('return response')
    expect(code).not.toMatch(/Failed to send password reset email/)
  })

  test('the neutral message does not name the address or its status', () => {
    const literal = code.match(/NEUTRAL_RESPONSE\s*=\s*'([^']+)'/)?.[1] ?? ''
    expect(literal.length).toBeGreaterThan(20)
    for (const tell of ['not found', 'no account', 'does not exist', 'unknown'])
      expect(literal.toLowerCase()).not.toContain(tell)
  })
})

describe('the rate limiter is not mistaken for the control', () => {
  test('rate limiting is keyed per email, so it cannot stop enumeration across addresses', () => {
    // Documented so nobody removes the uniform response believing the limiter
    // covers this. It limits hammering ONE mailbox; it does nothing about
    // walking a list.
    expect(code).toMatch(/password_reset:\$\{email/)
    expect(code).toContain('429')
  })
})
