/**
 * Is this a URL our server should be willing to POST to? (#24)
 *
 * Alert channels let a customer supply a webhook URL, and the server then makes a
 * request to it. That is a server-side request forgery primitive handed to the
 * user by design: the request originates inside our network, carries our source
 * address, and reaches whatever the URL names. On a cloud host the first thing
 * worth naming is `http://169.254.169.254/`, the instance metadata service, which
 * hands out credentials to anything that asks from the right place.
 *
 * So the URL is checked, and checked against the **resolved addresses** rather
 * than the hostname. Blocking the literal string `127.0.0.1` accomplishes nothing
 * on its own: an attacker controls DNS for their own domain and can point
 * `webhook.example.com` at `169.254.169.254`. The name is never the thing that
 * matters — the address it resolves to is.
 *
 * ## What is enforced
 *
 * - **https only.** Plaintext would put the alert payload on the wire, and http
 *   is how internal services that were never meant to be addressable are reached.
 * - **Port 443 only.** Arbitrary ports turn this into an internal port scanner:
 *   response timing alone distinguishes an open port from a closed one, so an
 *   endpoint that merely *attempts* a connection leaks the shape of the network.
 * - **No credentials in the URL.** `https://user:pass@host/` is a way to smuggle
 *   material into logs, and nothing legitimate needs it here.
 * - **Every resolved address must be public.** All of them, not the first — a
 *   hostname can answer with a public and a private address together, and which
 *   one a connection picks is not ours to decide.
 * - **No redirects at send time.** A 302 to the metadata service bypasses every
 *   check above, because the check ran against the original URL. See delivery.ts,
 *   which sets `redirect: 'error'` for this reason.
 *
 * ## What is not
 *
 * DNS rebinding is not fully closed. Between our resolution and the connection's
 * own resolution, a hostile record with a one-second TTL can change answers, and
 * closing that properly means connecting to a pinned address with a Host header —
 * which `fetch` will not do. The window is small and the checks above make it
 * much harder to reach anything useful through it, but this is a mitigation, not
 * a proof, and it is written down here rather than left for someone to assume.
 */

import { lookup } from 'node:dns/promises'

/** IPv4 ranges that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // RFC6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes cloud instance metadata
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
]

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4)
    return null
  let n = 0
  for (const part of parts) {
    // Reject "01", "1e2", "0x7f" and anything else that is not plain decimal —
    // some resolvers and some parsers disagree about those, and a disagreement
    // between our parser and the connection's is exactly the gap to avoid.
    if (!/^\d{1,3}$/.test(part))
      return null
    const octet = Number(part)
    if (octet > 255)
      return null
    n = (n * 256) + octet
  }
  return n
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const addr = v4ToInt(ip)
  const net = v4ToInt(base)
  if (addr === null || net === null)
    return false
  // Math rather than bit shifts: `<<` in JS is 32-bit signed, so a /8 mask comes
  // back negative and comparisons quietly invert.
  const size = 2 ** (32 - bits)
  return addr >= net && addr < net + size
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, or null if it is not one.
 *
 * Parsed rather than pattern-matched, because the same address has many spellings
 * and the interesting ones do not look alike. `[::ffff:169.254.169.254]` is
 * rewritten by the WHATWG URL parser as `::ffff:a9fe:a9fe` — the embedded IPv4
 * becomes hex — so a check looking for a dotted quad sees nothing to unwrap and
 * waves the metadata service straight through. That was a real hole here, caught
 * by probing the guard rather than by reading it.
 */
function parseV6(address: string): number[] | null {
  if (!address.includes(':'))
    return null

  let text = address
  const groups: number[] = []

  // A trailing dotted quad (::ffff:1.2.3.4) is the last 32 bits, so convert it to
  // two hex groups before the rest is parsed.
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (tail) {
    const v4 = v4ToInt(tail[1])
    if (v4 === null)
      return null
    text = `${text.slice(0, -tail[1].length)}${((v4 >>> 16) & 0xFFFF).toString(16)}:${(v4 & 0xFFFF).toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2)
    return null

  const toGroups = (part: string): number[] | null => {
    if (!part)
      return []
    const out: number[] = []
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece))
        return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }

  const head = toGroups(halves[0])
  const rest = halves.length === 2 ? toGroups(halves[1]) : []
  if (head === null || rest === null)
    return null

  if (halves.length === 2) {
    const gap = 8 - head.length - rest.length
    if (gap < 0)
      return null
    groups.push(...head, ...Array.from({ length: gap }, () => 0), ...rest)
  }
  else {
    groups.push(...head)
  }

  return groups.length === 8 ? groups : null
}

/** The dotted quad held in two 16-bit groups. */
function v4FromGroups(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xFF}.${lo >>> 8}.${lo & 0xFF}`
}

/**
 * Would connecting to this address leave the public internet?
 *
 * Pure, and separated from DNS so the range table can be tested exhaustively
 * without a resolver.
 */
export function isBlockedAddress(ip: string): boolean {
  const address = ip.trim().toLowerCase().replace(/%.*$/, '') // drop any zone id
  if (!address)
    return true

  if (address.includes(':')) {
    const groups = parseV6(address)
    if (groups === null)
      return true // unparseable — refuse rather than guess

    // Unspecified :: and loopback ::1
    if (groups.every(g => g === 0))
      return true
    if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1)
      return true

    // Anything carrying an IPv4 address in its low 32 bits is judged as that
    // IPv4 address: ::ffff:0:0/96 (mapped), ::/96 (compatible, deprecated) and
    // 64:ff9b::/96 (NAT64) all reach a v4 destination.
    const lowV4 = () => isBlockedAddress(v4FromGroups(groups[6], groups[7]))
    if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xFFFF)
      return lowV4()
    if (groups.slice(0, 6).every(g => g === 0))
      return lowV4()
    if (groups[0] === 0x64 && groups[1] === 0xFF9B)
      return lowV4()

    // 6to4 carries its IPv4 in the two groups after the prefix.
    if (groups[0] === 0x2002)
      return isBlockedAddress(v4FromGroups(groups[1], groups[2]))

    if ((groups[0] & 0xFE00) === 0xFC00) // fc00::/7 unique local
      return true
    if ((groups[0] & 0xFFC0) === 0xFE80) // fe80::/10 link local
      return true
    if ((groups[0] & 0xFF00) === 0xFF00) // ff00::/8 multicast
      return true

    return false
  }

  if (v4ToInt(address) === null)
    return true // not an address we can reason about — refuse rather than guess

  return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits))
}

export interface UrlVerdict {
  ok: boolean
  /** Why it was refused, phrased for the person who typed the URL. */
  reason?: string
}

/** The parts we can judge without touching the network. Exported for tests. */
export function checkUrlShape(raw: string): UrlVerdict & { url?: URL } {
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    return { ok: false, reason: 'That is not a valid URL.' }
  }

  if (url.protocol !== 'https:')
    return { ok: false, reason: 'Webhook URLs must use https.' }

  if (url.username || url.password)
    return { ok: false, reason: 'Webhook URLs must not contain a username or password.' }

  if (url.port && url.port !== '443')
    return { ok: false, reason: 'Webhook URLs must use the default https port.' }

  if (!url.hostname)
    return { ok: false, reason: 'That URL has no host.' }

  return { ok: true, url }
}

/**
 * Full check: shape, then every address the host resolves to.
 *
 * Called both when a URL is saved and again before each send. Re-checking is not
 * redundant — DNS is mutable, so a hostname that was public when it was saved can
 * be pointed at the metadata service afterwards, and a check that only ran at
 * write time would never notice.
 */
export async function checkWebhookUrl(raw: string): Promise<UrlVerdict> {
  const shape = checkUrlShape(raw)
  if (!shape.ok || !shape.url)
    return shape

  const host = shape.url.hostname.replace(/^\[|\]$/g, '')

  // An IP literal never reaches the resolver, so judge it directly.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    return isBlockedAddress(host)
      ? { ok: false, reason: 'That address is not reachable from the public internet.' }
      : { ok: true }
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  }
  catch {
    return { ok: false, reason: 'That host could not be resolved.' }
  }

  if (!addresses.length)
    return { ok: false, reason: 'That host could not be resolved.' }

  // Every address, not the first: a host answering with both a public and a
  // private address would otherwise pass while the connection takes the private
  // one.
  if (addresses.some(a => isBlockedAddress(a.address)))
    return { ok: false, reason: 'That host resolves to an address that is not reachable from the public internet.' }

  return { ok: true }
}
