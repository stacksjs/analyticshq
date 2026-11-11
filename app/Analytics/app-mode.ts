/**
 * App mode: events from a declared native or desktop app, not a browser.
 *
 * ## Why it exists
 *
 * A desktop app that wants to record opt-in, anonymous usage could not. Its
 * agent speaks HTTP through Bun, Node or an embedded webview, and the bot
 * filter drops `bun/`, `undici`, `node-fetch` and `electron` on sight, so every
 * event answered 204 and vanished. And the visitor id is a hash of the IP and
 * User-Agent under a salt that rotates daily, so even an event that got through
 * would make one install look like a new visitor every morning.
 *
 * ## What makes a request an app request
 *
 * Two things, and both are required:
 *
 *  1. The SITE is in app mode. Its owner turned it on (`sites.app_mode`), and
 *     that is the only thing that can. A field in the beacon cannot.
 *  2. The REQUEST declares an app client: a top-level `app` object carrying the
 *     install id and the app version.
 *
 * So web traffic cannot be passed off as app traffic on an ordinary site (the
 * declaration is refused with a 403, loudly, not dropped), and a bot cannot
 * skip the filter on a web site by adding a field. On an app-mode site a
 * request WITHOUT the declaration is plain web traffic, bot filter and all.
 *
 * ## The install id
 *
 * The app generates a random UUID, keeps it, and sends it. It is never stored.
 * What is stored is an HMAC of it under a secret that belongs to this one site
 * and does not rotate (`sites.app_secret`), so:
 *
 *  - one install is one visitor across days, which is the whole point,
 *  - the same install id sent to two sites gives two unrelated ids, and
 *  - turning app mode off deletes the secret, after which no stored id can be
 *    tied to an install id by anyone, us included.
 *
 * The IP and the User-Agent are not part of the hash. An install is the same
 * install on a train and after an OS update.
 *
 * Everything here is pure, so the rules can be tested without a database.
 */

import { createHmac, randomBytes } from 'node:crypto'

/** A canonical UUID, any version, lowercase. 36 characters exactly. */
export const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `1.4.2`, `2.0.0-beta.1`, `2026.11+build5`. Short, and no spaces. */
export const APP_VERSION_PATTERN = /^[0-9a-z][0-9a-z.+_-]{0,31}$/i

/** A display label: the app's name, or an OS we have no canonical spelling for. */
const LABEL_PATTERN = /^[0-9a-z][\w .-]{0,31}$/i

/** The browser column's value when the app sent no usable name. */
export const DEFAULT_APP_NAME = 'App'

/** What a declared app client told us, validated. */
export interface AppClient {
  /** The raw install id. Hashed by `hashInstall` and then discarded, never stored. */
  installId: string
  /** The app's display name, or null. Stored where a browser's name would be. */
  name: string | null
  version: string
  /** `macOS`, `Windows`, `Linux`, `iOS`, `Android`, or the label the app sent. */
  os: string | null
  /** Major and minor only. See `coarseOsVersion`. */
  osVersion: string | null
}

/** Did the beacon declare an app client at all? `null` and absent are both no. */
export function declaresApp(body: Record<string, unknown>): boolean {
  return body.app !== undefined && body.app !== null
}

/**
 * The spellings runtimes use for the same five systems. `process.platform`
 * says `darwin` and `win32`, and people type `macos` and `osx`. Folded to the
 * values the User-Agent parser already writes, so one Operating systems report
 * holds web and app traffic without a `macOS` row next to a `darwin` one.
 */
const OS_NAMES: Record<string, string> = {
  'macos': 'macOS',
  'mac': 'macOS',
  'mac os': 'macOS',
  'mac os x': 'macOS',
  'osx': 'macOS',
  'os x': 'macOS',
  'darwin': 'macOS',
  'windows': 'Windows',
  'win': 'Windows',
  'win32': 'Windows',
  'linux': 'Linux',
  'ios': 'iOS',
  'ipados': 'iOS',
  'android': 'Android',
}

/** A canonical OS name, the app's own short label, or null. Never a reason to refuse. */
export function normalizeAppOs(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const label = value.trim()
  const known = OS_NAMES[label.toLowerCase()]
  if (known)
    return known
  return LABEL_PATTERN.test(label) ? label : null
}

/**
 * An OS version cut to major and minor: `15.1.1` is stored as `15.1`, and a
 * kernel string like `24.1.0-arm64` as `24.1`.
 *
 * A full build number is a much smaller haystack than "macOS 15.1", and on an
 * app with a few hundred installs it can come close to naming one machine.
 * Nothing a report needs is finer than the minor release.
 */
export function coarseOsVersion(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number')
    return null
  const match = /^(\d{1,5})(?:\.(\d{1,5}))?/.exec(String(value).trim())
  if (!match)
    return null
  return match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`
}

function label(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const text = value.trim()
  return LABEL_PATTERN.test(text) ? text : null
}

/**
 * Validate the beacon's `app` object.
 *
 * The install id and the version are required and refused when malformed,
 * because a wrong one is a bug in the app that should be seen: a bad id would
 * otherwise be silently counted as a visitor that can never return. The name
 * and the OS are optional decoration, dropped to null when unusable.
 */
export function readAppClient(raw: unknown): { client: AppClient } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { error: 'app must be an object with id and version' }
  const app = raw as Record<string, unknown>

  const id = typeof app.id === 'string' ? app.id.trim().toLowerCase() : ''
  if (!INSTALL_ID_PATTERN.test(id))
    return { error: 'app.id must be a UUID, for example the value of crypto.randomUUID()' }

  const version = typeof app.version === 'string' ? app.version.trim() : ''
  if (!APP_VERSION_PATTERN.test(version))
    return { error: 'app.version must be a version string of at most 32 characters, for example 1.4.2' }

  return {
    client: {
      installId: id,
      name: label(app.name),
      version,
      os: normalizeAppOs(app.os),
      osVersion: coarseOsVersion(app.osVersion),
    },
  }
}

/** A fresh site secret. 32 random bytes, hex, so it fits a varchar(64). */
export function mintAppSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The stored visitor id for one install on one site.
 *
 * No date and no IP go in, on purpose: the id has to be the same tomorrow and
 * on another network. The site id is inside the MAC as well as being the owner
 * of the secret, so two sites that somehow shared a secret would still not
 * share ids. Truncated to 32 hex characters, the width of every other visitor
 * id, so the reports cannot tell the two kinds apart.
 */
export function hashInstall(installId: string, siteId: string, secret: string): string {
  return createHmac('sha256', secret).update(`app|${siteId}|${installId}`).digest('hex').slice(0, 32)
}

/** The dimension columns an app event fills, in the shape the UA parser gives web traffic. */
export interface AppDimensions {
  deviceType: 'desktop' | 'mobile' | 'tablet'
  browser: string
  browserVersion: string
  os: string
  osVersion: string | null
}

/**
 * Where an app's facts go in the columns the reports already read.
 *
 * The app's name sits where a browser's name would and its version where the
 * browser's version would, because that is what they are: the client the person
 * used. So Browsers lists the app, Operating systems lists the OS, and the
 * `browser` and `os` filters work on app traffic with no new dimension.
 */
export function appDimensions(client: AppClient): AppDimensions {
  return {
    deviceType: client.os === 'iOS' || client.os === 'Android' ? 'mobile' : 'desktop',
    browser: client.name ?? DEFAULT_APP_NAME,
    browserVersion: client.version,
    os: client.os ?? 'Unknown',
    osVersion: client.osVersion,
  }
}

/**
 * An event's properties with the app's version and OS added.
 *
 * custom_events has no dimension columns, so this is how an event can be broken
 * down by version. The three keys are set last and win over anything the caller
 * sent under the same name: they describe the client, and a report grouping by
 * `app_version` has to be able to trust it.
 */
export function withAppProperties(properties: unknown, client: AppClient): Record<string, unknown> {
  const base = (typeof properties === 'object' && properties !== null && !Array.isArray(properties))
    ? properties as Record<string, unknown>
    : {}
  const merged: Record<string, unknown> = { ...base, app_version: client.version }
  delete merged.os
  delete merged.os_version
  if (client.os)
    merged.os = client.os
  if (client.osVersion)
    merged.os_version = client.osVersion
  return merged
}
