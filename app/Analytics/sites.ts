/**
 * Creating a site, the rules shared by every way one gets made.
 *
 * The dashboard (`POST /api/sites`) and the operator script
 * (`scripts/account.ts --create-site`) both create sites. They have to agree
 * on what a valid name is and, above all, on how the id is minted: the id is
 * the public `data-site` value in every snippet, so a guessable one would let
 * anybody pre-register a live site's traffic under their own account.
 */

import { createHash, randomUUID } from 'node:crypto'

const MAX_LENGTH = 255

export interface SiteInput {
  name: string
  domain: string
}

/** Trimmed and bounded, or the reason it cannot be used. */
export function normalizeSiteInput(input: { name?: unknown, domain?: unknown }): SiteInput | { error: string } {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, MAX_LENGTH) : ''
  const domain = typeof input.domain === 'string' ? input.domain.trim().slice(0, MAX_LENGTH) : ''
  if (!name)
    return { error: 'name is required' }
  return { name, domain }
}

/**
 * A 24-hex site id, never chosen by the caller. Seeded with the owner, the
 * name, fresh randomness and the time, so two sites minted in the same
 * millisecond for the same owner still differ.
 */
export function mintSiteId(ownerId: number, name: string): string {
  return createHash('sha256').update(`${ownerId}|${name}|${randomUUID()}|${Date.now()}`).digest('hex').slice(0, 24)
}
