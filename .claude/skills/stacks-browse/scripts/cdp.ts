#!/usr/bin/env bun
/**
 * Shared CDP primitives for the /stacks-browse SPA probes.
 *
 * Same dependency-free approach as `browse.ts` — a Chromium already on the
 * machine, driven over the Chrome DevTools Protocol with only `Bun.spawn`,
 * `fetch` and `WebSocket`. `browse.ts` is a self-contained CLI with no exports,
 * so the primitives live here rather than being refactored out of it.
 *
 * What this adds over `browse.ts`: the probes need to *click* a link and watch
 * what the network does, not just `Page.navigate` to a URL. A full-document
 * request after a click is the signal that SPA routing fell back to a reload.
 */

import { spawn } from 'bun'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Browser discovery ──────────────────────────────────────────────────────

function which(bin: string): string | null {
  try {
    const r = Bun.spawnSync(['which', bin])
    const out = r.stdout.toString().trim()
    return out && existsSync(out) ? out : null
  }
  catch {
    return null
  }
}

function collectCandidates(): string[] {
  const out: string[] = []
  const add = (p: string | null) => { if (p && existsSync(p) && !out.includes(p)) out.push(p) }

  if (process.env.BROWSE_BROWSER)
    add(process.env.BROWSE_BROWSER)

  for (const bin of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave-browser', 'microsoft-edge', 'chrome'])
    add(which(bin))

  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ]) add(p)

  const cacheRoot = join(process.env.HOME || '', 'Library/Caches/ms-playwright')
  if (existsSync(cacheRoot)) {
    try {
      const hit = Bun.spawnSync(['find', cacheRoot, '-maxdepth', '3', '-name', 'chrome-headless-shell', '-o', '-maxdepth', '3', '-name', 'Chromium'])
      for (const p of hit.stdout.toString().trim().split('\n').filter(Boolean)) add(p)
    }
    catch { /* ignore */ }
  }

  if (!out.length)
    throw new Error('No Chromium-family browser found. Install one (e.g. `brew install --cask chromium`) or set BROWSE_BROWSER=/path/to/chrome.')
  return out
}

function runs(bin: string): boolean {
  try {
    const r = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    return r.exitCode === 0 && r.stdout.toString().trim().length > 0
  }
  catch {
    return false
  }
}

// ── Minimal CDP client ──────────────────────────────────────────────────────

export interface CdpEvent { method: string, params: any }

export class Cdp {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>()
  private listeners: ((e: CdpEvent) => void)[] = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev: any) => {
      const msg = JSON.parse(ev.data)
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
      else if (msg.method) {
        for (const l of this.listeners) l({ method: msg.method, params: msg.params })
      }
    })
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); resolve(new Cdp(ws)) })
      ws.addEventListener('error', e => { clearTimeout(t); reject(e) })
    })
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(fn: (e: CdpEvent) => void): void {
    this.listeners.push(fn)
  }

  /** Evaluate an expression and return its value, awaiting promises. */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value as T
  }

  close(): void {
    try { this.ws.close() }
    catch { /* ignore */ }
  }
}

// ── Browser lifecycle ───────────────────────────────────────────────────────

export interface Session { proc: ReturnType<typeof spawn>, port: number, userDataDir: string, browser: string }

async function tryLaunch(browser: string): Promise<Session | null> {
  const userDataDir = join(tmpdir(), `stacks-probe-${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 1000000n))}`)
  mkdirSync(userDataDir, { recursive: true })

  const isHeadlessShell = /chrome-headless-shell|headless_shell/.test(browser)
  const proc = spawn([
    browser,
    ...(isHeadlessShell ? [] : ['--headless=new']),
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    'about:blank',
  ], { stdout: 'ignore', stderr: 'ignore' })

  const portFile = join(userDataDir, 'DevToolsActivePort')
  for (let i = 0; i < 80; i++) {
    if (existsSync(portFile)) {
      const line = readFileSync(portFile, 'utf8').split('\n')[0]?.trim()
      if (line)
        return { proc, port: Number(line), userDataDir, browser }
    }
    await Bun.sleep(50)
  }
  try { proc.kill() }
  catch { /* ignore */ }
  return null
}

export async function launch(): Promise<Session> {
  const tried: string[] = []
  for (const browser of collectCandidates()) {
    if (!runs(browser)) { tried.push(`${browser} (won't run)`); continue }
    const s = await tryLaunch(browser)
    if (s)
      return s
    tried.push(`${browser} (no DevTools port)`)
  }
  throw new Error(`Could not launch any browser. Tried:\n  ${tried.join('\n  ')}\nSet BROWSE_BROWSER=/path/to/chrome to override.`)
}

export async function openPage(port: number): Promise<Cdp> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[]
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl)
        return Cdp.connect(page.webSocketDebuggerUrl)
    }
    catch { /* not ready yet */ }
    await Bun.sleep(50)
  }
  throw new Error('Could not find a page target to attach to.')
}

export function kill(s: Session): void {
  try { s.proc.kill() }
  catch { /* ignore */ }
}

// ── Instrumentation ─────────────────────────────────────────────────────────

export interface Req { url: string, type: string, status?: number }

export interface Instrumented {
  requests: Req[]
  consoleErrors: string[]
  /** Forget everything recorded so far — call right before the action under test. */
  reset: () => void
  /** Document-type requests, i.e. full page loads. */
  documents: () => Req[]
}

/** Enable the CDP domains the probes need and start recording. */
export async function instrument(cdp: Cdp): Promise<Instrumented> {
  const state = { requests: [] as Req[], consoleErrors: [] as string[] }

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')

  cdp.on((e) => {
    if (e.method === 'Network.requestWillBeSent') {
      state.requests.push({ url: e.params.request.url, type: e.params.type || 'Other' })
    }
    else if (e.method === 'Network.responseReceived') {
      const hit = state.requests.find(r => r.url === e.params.response.url && r.status == null)
      if (hit) { hit.status = e.params.response.status; hit.type = e.params.type || hit.type }
    }
    else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails
      state.consoleErrors.push(d?.exception?.description || d?.text || 'Uncaught exception')
    }
    else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      state.consoleErrors.push((e.params.args || []).map((a: any) => a.value ?? a.description ?? a.type).join(' '))
    }
  })

  return {
    get requests() { return state.requests },
    get consoleErrors() { return state.consoleErrors },
    reset() { state.requests.length = 0; state.consoleErrors.length = 0 },
    documents() { return state.requests.filter(r => r.type === 'Document') },
  }
}

/** Navigate and settle. Long-poll/SSE pages may never fire load, so we proceed anyway. */
export async function goto(cdp: Cdp, url: string, settleMs = 800): Promise<void> {
  await cdp.send('Page.navigate', { url })
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 15_000)
    cdp.on((e) => { if (e.method === 'Page.loadEventFired') { clearTimeout(t); resolve() } })
  })
  await Bun.sleep(settleMs)
}

/**
 * Click the first in-page link whose href matches, then settle.
 * Returns false when no such link exists — a missing link and a broken router
 * are different failures and must not be reported as the same thing.
 */
export async function clickLink(cdp: Cdp, hrefStartsWith: string, settleMs = 1200): Promise<boolean> {
  const clicked = await cdp.eval<boolean>(`(() => {
    const a = Array.from(document.querySelectorAll('a[href]'))
      .find(a => (a.getAttribute('href') || '').split('?')[0] === ${JSON.stringify(hrefStartsWith)});
    if (!a) return false;
    a.click();
    return true;
  })()`)
  if (clicked)
    await Bun.sleep(settleMs)
  return clicked
}

export async function setViewport(cdp: Cdp, w: number, h: number): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
}
