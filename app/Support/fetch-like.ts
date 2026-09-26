/**
 * The part of `fetch` an injectable API client calls: a URL and options in, a
 * Response out.
 *
 * Not `typeof fetch`. Bun's global also carries `fetch.preconnect`, which a
 * test double has no reason to implement, so tests had to cast theirs past it.
 * The real `fetch` is still assignable to this.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
