/**
 * Invitation tokens, and the rules for redeeming one.
 *
 * Everything here is pure. The database work lives in the routes; what is kept
 * separate is the part that decides, because an invitation is a bearer
 * credential and the decisions around one are exactly what a test needs to pin
 * down. `shareTokenVerdict` in `connect.ts` exists for the same reason, after
 * inlining that logic let a mutation survive the entire suite.
 *
 * ## The shape of the threat
 *
 * A link that grants access to someone else's analytics gets forwarded, quoted
 * in a ticket, and sits in a mailbox for years. So:
 *
 *   - only a hash is stored, so the database never holds anything redeemable
 *   - it expires, because a mailbox is not a vault
 *   - it is single use, so a forwarded thread cannot be replayed
 *   - it is bound to the address it was sent to, so possession alone is not
 *     enough — the person redeeming it must control that mailbox
 *
 * That last rule is the one that makes this not an account-takeover flow. #19
 * refused to ship invitations without it, and the reasoning was right: an
 * endpoint that turns an unauthenticated email address into an account is an
 * account-creation path wearing a different name.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * How long an invitation stays redeemable.
 *
 * Long enough to survive a weekend and a holiday, short enough that a forwarded
 * thread from last quarter is inert. `config/auth.ts` sets password resets far
 * shorter, which is right for a credential the user requested seconds ago and
 * wrong for one that arrives unannounced and may need a reply first.
 */
export const INVITE_TTL_HOURS = 14 * 24

/** Bytes of entropy in a token. 32 bytes is 256 bits, rendered as 64 hex chars. */
const TOKEN_BYTES = 32

/**
 * A fresh invitation token. Returned raw exactly once — it goes into the email
 * and is never stored, logged, or returned by any endpoint afterwards.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/** What actually goes in the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(String(token)).digest('hex')
}

/**
 * Compare two hashes without leaking their contents through timing.
 *
 * Both sides are re-hashed so the buffers are always equal length —
 * `timingSafeEqual` throws on a length mismatch, and catching that would itself
 * be a length oracle. Same reasoning as `tokensMatch` for widget tokens.
 */
export function hashesMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b)
    return false
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

/**
 * The address an invitation is for, in the one form it is ever compared in.
 *
 * Both the invite and the redeeming account go through this, so a mismatch can
 * only ever mean a genuinely different address rather than different casing.
 */
export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** A plausible address. Deliberately permissive — delivery is the real test. */
export function looksLikeEmail(value: unknown): boolean {
  const email = normalizeEmail(value)
  return email.length > 2 && email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** When an invitation minted now stops being redeemable. */
export function expiryFrom(now: Date = new Date(), hours: number = INVITE_TTL_HOURS): string {
  return new Date(now.getTime() + hours * 3600_000).toISOString()
}

export interface InviteRow {
  email: string
  role: string
  expires_at: string | null
  accepted_at: string | null
}

export type InviteRefusal = 'not_found' | 'expired' | 'already_accepted' | 'wrong_account'

/**
 * May this invitation be redeemed, by this account, now?
 *
 * Returns `null` when it may, or the reason it may not. Split out so every
 * refusal path is reachable from a test without standing up Postgres and a
 * mail server.
 *
 * The caller must answer the same way to every refusal. This function names
 * them because the SERVER needs to know which happened — an expired invitation
 * deserves a "request a new one" page, not a generic failure — but the reason
 * must never be inferable by someone holding a token they were not given. Only
 * the account the invitation names may learn anything from it.
 */
export function inviteRefusal(
  invite: InviteRow | null | undefined,
  accountEmail: unknown,
  now: Date = new Date(),
): InviteRefusal | null {
  if (!invite)
    return 'not_found'

  if (invite.accepted_at)
    return 'already_accepted'

  // Expiry before identity: a stale invitation is stale whoever presents it,
  // and checking identity first would let the wrong holder distinguish "this
  // token is live but not yours" from "this token is dead".
  const expiresAt = invite.expires_at ? Date.parse(invite.expires_at) : Number.NaN
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime())
    return 'expired'

  if (normalizeEmail(invite.email) !== normalizeEmail(accountEmail))
    return 'wrong_account'

  return null
}
