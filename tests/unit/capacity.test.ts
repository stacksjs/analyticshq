/**
 * Capacity checks for StatusHQ (app/Analytics/capacity.ts).
 *
 * StatusHQ only alerts on `failed`, so these pin the lines that page someone,
 * that every alert says what to do, and that the host readers parse what
 * Linux actually writes.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cpuLoadCheck,
  dbConnectionsCheck,
  diskCheck,
  gatewayMemory,
  gatewayMemoryCheck,
  hostMemoryCheck,
  level,
  liveStreamsCheck,
  load15,
  loopbackConnections,
  loopbackPortsCheck,
  meminfo,
  portRangeSize,
  THRESHOLDS,
} from '../../app/Analytics/capacity'

const ROOT = join(import.meta.dir, '../..')

describe('levels', () => {
  test('warning is a heads-up, failed is the alert', () => {
    expect(level(49, THRESHOLDS.liveStreams)).toBe('ok')
    expect(level(50, THRESHOLDS.liveStreams)).toBe('warning')
    expect(level(70, THRESHOLDS.liveStreams)).toBe('failed')
  })

  test('every alert line leaves room to act before anything breaks', () => {
    for (const t of Object.values(THRESHOLDS))
      expect(t.warning).toBeLessThan(t.failure)
    // The horizontal limits alert with ~30% left: time to stand up a server.
    expect(THRESHOLDS.liveStreams.failure).toBeLessThanOrEqual(70)
    expect(THRESHOLDS.loopbackPorts.failure).toBeLessThanOrEqual(70)
  })
})

describe('each alert says what to do', () => {
  test('streams and ports say add a server, not a bigger one', () => {
    const streams = liveStreamsCheck(15000, 20000)
    expect(streams.status).toBe('failed')
    expect(streams.shortSummary).toBe('75%')
    expect(streams.notificationMessage).toContain('add a second server rather than a bigger one')
    expect(loopbackPortsCheck(20000, 28232).notificationMessage).toContain('add a second server')
  })

  test('memory and CPU say a larger server', () => {
    expect(hostMemoryCheck(16_000_000, 1_000_000).status).toBe('failed')
    expect(hostMemoryCheck(16_000_000, 1_000_000).notificationMessage).toContain('larger server (more RAM)')
    const cpu = cpuLoadCheck(7.6, 8)
    expect(cpu.status).toBe('failed')
    expect(cpu.notificationMessage).toContain('larger server (more CPU)')
    expect(cpuLoadCheck(5.8, 8).status).toBe('warning')
  })

  test('the gateway names the drop-in to edit', () => {
    const gw = gatewayMemoryCheck(1.8 * 1024 ** 3, 2 * 1024 ** 3)
    expect(gw.status).toBe('failed')
    expect(gw.notificationMessage).toContain('60-live-connections.conf')
  })

  test('disk points at retention as well as a bigger volume', () => {
    expect(diskCheck(74, 39).status).toBe('ok')
    expect(diskCheck(82, 27).status).toBe('warning')
    expect(diskCheck(91, 13).notificationMessage).toContain('ANALYTICSHQ_RETENTION_DAYS')
  })

  test('database connections count the whole box', () => {
    expect(dbConnectionsCheck(57, 300).status).toBe('ok')
    expect(dbConnectionsCheck(260, 300).status).toBe('failed')
  })

  test('an unreadable number is skipped, never ok', () => {
    expect(hostMemoryCheck(null, null).status).toBe('skipped')
    expect(gatewayMemoryCheck(null, null).status).toBe('skipped')
    expect(diskCheck(null, null).status).toBe('skipped')
  })

  test('an ok check carries no message to send', () => {
    expect(liveStreamsCheck(10, 20000).notificationMessage).toBe('')
  })
})

describe('reading the host', () => {
  const files: Record<string, string> = {
    '/proc/meminfo': 'MemTotal:       15988132 kB\nMemFree:          750000 kB\nMemAvailable:    5647000 kB\n',
    '/proc/loadavg': '0.68 0.71 0.80 1/1976 1320423\n',
    '/proc/sys/net/ipv4/ip_local_port_range': '32768\t60999\n',
    '/proc/net/tcp': [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BD0 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1',
      '   1: 0100007F:C3F2 0100007F:0BD1 01 00000000:00000000 00:00000000 00000000     0        0 2 1',
      '   2: 0100007F:0BD1 0100007F:C3F2 01 00000000:00000000 00:00000000 00000000     0        0 3 1',
      '   3: BC30F8B2:01BB 0A0B0C0D:D431 01 00000000:00000000 00:00000000 00000000     0        0 4 1',
    ].join('\n'),
    '/proc/net/tcp6': '',
    '/sys/fs/cgroup/system.slice/rpx-gateway.service/memory.current': '63832064\n',
    '/sys/fs/cgroup/system.slice/rpx-gateway.service/memory.high': '2147483648\n',
  }
  const read = (p: string) => files[p] ?? null

  test('parses what Linux writes', () => {
    expect(meminfo(read)).toEqual({ totalKb: 15988132, availableKb: 5647000 })
    expect(load15(read)).toBe(0.8)
    expect(portRangeSize(read)).toBe(28232)
    expect(gatewayMemory(read)).toEqual({ current: 63832064, high: 2147483648 })
  })

  test('a loopback connection is counted once, and listeners and outside peers not at all', () => {
    expect(loopbackConnections(read)).toBe(1)
  })

  test('a missing file reads as unavailable', () => {
    const none = () => null
    expect(meminfo(none)).toEqual({ totalKb: null, availableKb: null })
    expect(load15(none)).toBeNull()
    expect(loopbackConnections(none)).toBeNull()
    expect(gatewayMemory(none)).toEqual({ current: null, high: null })
  })
})

describe('the endpoint', () => {
  const routes = readFileSync(join(ROOT, 'routes/analytics.ts'), 'utf8')
  const i = routes.indexOf(`route.get('/api/health/capacity'`)
  const block = routes.slice(i, routes.indexOf('\nroute.', i + 10))

  test('is off until a secret is set, and checks it in constant time', () => {
    expect(block).toContain(`if (!secret)\n    return json({ error: 'Not found' }, 404)`)
    expect(block).toContain(`tokensMatch(String(request.headers?.get('oh-dear-health-check-secret') ?? ''), secret)`)
    expect(block.indexOf('tokensMatch(')).toBeLessThan(block.indexOf('capacityReport('))
  })

  test('is never cached', () => {
    expect(block).toContain(`'Cache-Control': 'no-store'`)
  })
})
