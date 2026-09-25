/**
 * Capacity checks: is it time to add a server, or a bigger one?
 *
 * Served at GET /api/health/capacity in the spatie/laravel-health (Oh Dear)
 * schema, which StatusHQ reads natively. A StatusHQ "Health Check" monitor on
 * that URL turns these into alerts.
 *
 * ## Warning is a heads-up, failed is the alert
 *
 * StatusHQ shows a `warning` as a degraded monitor but only opens an incident,
 * and notifies anyone, when a check is `failed`. So `failed` here does not
 * mean broken. It means "act this week": each failure threshold is set with
 * enough headroom left to order a server and move before anything degrades.
 * `warning` is the earlier line you can see on the dashboard without being
 * paged for it.
 *
 * ## What each check means you should do
 *
 * The limits on this box are of two kinds, and they call for different fixes:
 *
 * - **Horizontal (add a server).** Live dashboard streams and loopback
 *   connection slots. Each stream is a loopback connection at every proxy
 *   hop, and the ephemeral port range gives each hop about 28000, so one box
 *   tops out around 24000 streams however big it is. A bigger box does not
 *   help. A second one does.
 * - **Vertical (a bigger server).** Memory, CPU, and the gateway's memory.
 *   These grow with traffic and a larger instance fixes them outright.
 * - **Disk.** Grow the volume, or shorten ANALYTICSHQ_RETENTION_DAYS.
 * - **Database connections.** Raise max_connections or pool harder, and
 *   past that give Postgres its own server.
 *
 * Every `notificationMessage` says which, so the alert is the runbook.
 *
 * Readers are injected so the checks are tested without a Linux host.
 */

import { readFileSync, statfsSync } from 'node:fs'
import { cpus } from 'node:os'

export type CheckStatus = 'ok' | 'warning' | 'failed' | 'crashed' | 'skipped'

export interface CheckResult {
  name: string
  label: string
  status: CheckStatus
  notificationMessage: string
  shortSummary: string
  meta: Record<string, unknown>
}

export interface HealthReport {
  finishedAt: string
  checkResults: CheckResult[]
}

export interface Thresholds { warning: number, failure: number }

/** The levels each check warns and alerts at, in one place. */
export const THRESHOLDS = {
  liveStreams: { warning: 50, failure: 70 },
  loopbackPorts: { warning: 50, failure: 70 },
  gatewayMemory: { warning: 60, failure: 80 },
  hostMemory: { warning: 80, failure: 90 },
  cpuLoad: { warning: 0.7, failure: 0.9 },
  disk: { warning: 80, failure: 90 },
  dbConnections: { warning: 70, failure: 85 },
} satisfies Record<string, Thresholds>

/** ok / warning / failed for a value against its two lines. */
export function level(value: number, t: Thresholds): CheckStatus {
  return value >= t.failure ? 'failed' : value >= t.warning ? 'warning' : 'ok'
}

function check(
  name: string,
  label: string,
  value: number | null,
  t: Thresholds,
  shortSummary: string,
  advice: string,
  meta: Record<string, unknown>,
): CheckResult {
  if (value === null || !Number.isFinite(value))
    return { name, label, status: 'skipped', notificationMessage: `${label} could not be read on this host.`, shortSummary: 'unavailable', meta }
  const status = level(value, t)
  const notificationMessage = status === 'ok'
    ? ''
    : `${label} is at ${shortSummary}, past the ${status === 'failed' ? 'alert' : 'warning'} line of ${status === 'failed' ? t.failure : t.warning}${shortSummary.endsWith('%') ? '%' : ''}. ${advice}`
  return { name, label, status, notificationMessage, shortSummary, meta: { ...meta, warning_at: t.warning, alert_at: t.failure } }
}

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null

// ---------------------------------------------------------------------------
// The checks. Each takes the raw numbers, so tests need no host.
// ---------------------------------------------------------------------------

export function liveStreamsCheck(streams: number, cap: number): CheckResult {
  const used = pct(streams, cap)
  return check('LiveStreams', 'Live dashboard streams', used, THRESHOLDS.liveStreams, `${used}%`,
    `${streams} of ${cap} streams are open. One server tops out around 24000 whatever its size, so add a second server rather than a bigger one (see DEPLOY.md, "Live dashboards and the proxy pools").`,
    { streams, cap })
}

export function loopbackPortsCheck(connections: number, rangeSize: number): CheckResult {
  const used = pct(connections, rangeSize)
  return check('LoopbackPorts', 'Loopback connection slots', used, THRESHOLDS.loopbackPorts, `${used}%`,
    `${connections} loopback connections against ${rangeSize} ephemeral ports per hop. This is the per-server connection ceiling: add a second server.`,
    { connections, port_range: rangeSize })
}

export function gatewayMemoryCheck(currentBytes: number | null, highBytes: number | null): CheckResult {
  const used = currentBytes !== null && highBytes ? pct(currentBytes, highBytes) : null
  return check('GatewayMemory', 'Gateway (rpx) memory', used, THRESHOLDS.gatewayMemory, `${used}%`,
    `rpx uses ${Math.round((currentBytes ?? 0) / 1048576)}MB of its ${Math.round((highBytes ?? 0) / 1048576)}MB soft limit, and every site on the box goes through it. Raise MemoryHigh/MemoryMax in /etc/systemd/system/rpx-gateway.service.d/60-live-connections.conf, or move to a larger server.`,
    { current_mb: currentBytes === null ? null : Math.round(currentBytes / 1048576), high_mb: highBytes === null ? null : Math.round(highBytes / 1048576) })
}

export function hostMemoryCheck(totalKb: number | null, availableKb: number | null): CheckResult {
  const used = totalKb && availableKb !== null ? pct(totalKb - availableKb, totalKb) : null
  return check('HostMemory', 'Server memory', used, THRESHOLDS.hostMemory, `${used}%`,
    'Move to a larger server (more RAM), or move a tenant off this one.',
    { total_mb: totalKb ? Math.round(totalKb / 1024) : null, available_mb: availableKb === null ? null : Math.round(availableKb / 1024) })
}

export function cpuLoadCheck(load15: number | null, cores: number): CheckResult {
  const perCore = load15 !== null && cores > 0 ? Math.round((load15 / cores) * 100) / 100 : null
  return check('CpuLoad', 'CPU load (15 min, per core)', perCore, THRESHOLDS.cpuLoad, `${perCore}`,
    `The 15-minute load is ${load15} across ${cores} cores, so the box has been busy for a while, not just spiking. Move to a larger server (more CPU).`,
    { load15, cores })
}

export function diskCheck(usedPct: number | null, freeGb: number | null): CheckResult {
  return check('UsedDiskSpace', 'Used disk space', usedPct, THRESHOLDS.disk, `${usedPct}%`,
    `${freeGb}GB left. Postgres shares this disk. Grow the volume, or shorten ANALYTICSHQ_RETENTION_DAYS so old page views are pruned.`,
    { free_gb: freeGb })
}

export function dbConnectionsCheck(used: number | null, max: number | null): CheckResult {
  const u = used !== null && max ? pct(used, max) : null
  return check('DatabaseConnections', 'Postgres connections', u, THRESHOLDS.dbConnections, `${u}%`,
    `${used} of ${max} connections are open, across every app on the box. Raise max_connections or pool harder, and past that give Postgres its own server.`,
    { used, max })
}

// ---------------------------------------------------------------------------
// Reading the host. Linux only, and every reader degrades to null.
// ---------------------------------------------------------------------------

type Read = (path: string) => string | null

export const readText: Read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return null
  }
}

/** MemTotal and MemAvailable, in kB, from /proc/meminfo. */
export function meminfo(read: Read = readText): { totalKb: number | null, availableKb: number | null } {
  const text = read('/proc/meminfo') ?? ''
  const field = (k: string) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  return { totalKb: field('MemTotal'), availableKb: field('MemAvailable') }
}

/** The 15-minute load average. */
export function load15(read: Read = readText): number | null {
  const parts = (read('/proc/loadavg') ?? '').trim().split(/\s+/)
  const n = Number(parts[2])
  return parts.length >= 3 && Number.isFinite(n) ? n : null
}

/** Size of the ephemeral port range, from ip_local_port_range. */
export function portRangeSize(read: Read = readText): number | null {
  const [lo, hi] = (read('/proc/sys/net/ipv4/ip_local_port_range') ?? '').trim().split(/\s+/).map(Number)
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? hi - lo + 1 : null
}

/**
 * Loopback TCP connections, from /proc/net/tcp and tcp6, counted by line so
 * tens of thousands of them stay cheap. 0100007F is 127.0.0.1 in the kernel's
 * byte order, and the v6 forms are ::1 and a v4-mapped 127.0.0.1.
 *
 * Both ends of a loopback connection live on this host, so each shows up as
 * two sockets. Each connection takes one ephemeral port, hence the halving.
 * All hops are summed against one port range, which overstates the pressure
 * a little and alerts early rather than late.
 */
export function loopbackConnections(read: Read = readText): number | null {
  const v4 = read('/proc/net/tcp')
  const v6 = read('/proc/net/tcp6')
  if (v4 === null && v6 === null)
    return null
  let n = 0
  for (const line of (v4 ?? '').split('\n')) {
    if (line.includes(':') && /\b0100007F:[0-9A-F]{4}\s+0100007F:/.test(line))
      n++
  }
  for (const line of (v6 ?? '').split('\n')) {
    if (/\b(?:00000000000000000000000001000000|0000000000000000FFFF00000100007F):[0-9A-F]{4}\s+(?:00000000000000000000000001000000|0000000000000000FFFF00000100007F):/.test(line))
      n++
  }
  return Math.ceil(n / 2)
}

/** rpx's cgroup memory, current and soft limit, in bytes. */
export function gatewayMemory(read: Read = readText, unit = 'rpx-gateway.service'): { current: number | null, high: number | null } {
  const base = `/sys/fs/cgroup/system.slice/${unit}`
  const num = (s: string | null) => {
    const n = Number((s ?? '').trim())
    return Number.isFinite(n) && (s ?? '').trim() !== '' ? n : null
  }
  return { current: num(read(`${base}/memory.current`)), high: num(read(`${base}/memory.high`)) }
}

/** Used percentage and free GB of the filesystem holding `path`. */
export function disk(path = '/'): { usedPct: number | null, freeGb: number | null } {
  try {
    const s = statfsSync(path)
    const total = s.blocks * s.bsize
    const free = s.bavail * s.bsize
    const used = total - s.bfree * s.bsize
    // `df` divides by used + available, leaving out the root-reserved blocks.
    return { usedPct: pct(used, used + free), freeGb: Math.round(free / 1e9) }
  }
  catch {
    return { usedPct: null, freeGb: null }
  }
}

export function coreCount(): number {
  return cpus().length || 1
}

/** Run every check. One that throws is `crashed`, never the whole report. */
export async function capacityReport(checks: Array<() => CheckResult | Promise<CheckResult>>): Promise<HealthReport> {
  const checkResults = await Promise.all(checks.map(async (run) => {
    try {
      return await run()
    }
    catch (error) {
      return { name: 'UnknownCheck', label: 'Unknown check', status: 'crashed' as const, notificationMessage: error instanceof Error ? error.message : String(error), shortSummary: 'crashed', meta: {} }
    }
  }))
  return { finishedAt: String(Math.floor(Date.now() / 1000)), checkResults }
}
