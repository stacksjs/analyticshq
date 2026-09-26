/**
 * Custom events declared in markup.
 *
 * `window.analyticshq(name, props)` is the only way to send a custom event,
 * and some sites cannot call it: templates that keep script out of markup, a
 * CMS field, a marketing page built by someone who does not write JavaScript.
 * `data-analyticshq-event` on any element sends that event on click, with the
 * other `data-analyticshq-*` attributes as its properties.
 *
 * The tracker is run for real here, inside a small fake DOM, rather than read
 * as text: what matters is what reaches /collect.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '../../public/script.js'), 'utf8')

interface FakeElement {
  tag: string
  href?: string
  attrs: Record<string, string>
  parent?: FakeElement
}

function element(tag: string, attrs: Record<string, string> = {}, parent?: FakeElement): FakeElement {
  return { tag, attrs, parent, href: attrs.href ? new URL(attrs.href, 'https://fan.example/').href : undefined }
}

/** Just enough of an Element for `closest`, attributes and `href`. */
interface FakeNode {
  href: string | undefined
  attributes: Array<{ name: string, value: string }>
  getAttribute: (name: string) => string | null
  hasAttribute: (name: string) => boolean
  closest: (selector: string) => FakeNode | null
}

/** A click as the tracker's listener reads it. */
interface FakeClick { type: string, target: FakeNode }

/** One beacon body the tracker posted: `e` is the event name, `p` its properties. */
type Beacon = Record<string, unknown>

function dom(el: FakeElement): FakeNode {
  const matches = (candidate: FakeElement, selector: string): boolean => {
    if (selector === 'a')
      return candidate.tag === 'a'
    const attr = selector.match(/^\[([\w-]+)\]$/)?.[1]
    return attr ? attr in candidate.attrs : false
  }
  return {
    href: el.href,
    attributes: Object.entries(el.attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (name: string) => el.attrs[name] ?? null,
    hasAttribute: (name: string) => name in el.attrs,
    closest(selector: string): FakeNode | null {
      for (let at: FakeElement | undefined = el; at; at = at.parent) {
        if (matches(at, selector))
          return dom(at)
      }
      return null
    },
  }
}

/** Load the tracker and return what it posts, plus a way to click. */
function load() {
  const sent: Beacon[] = []
  const listeners: Record<string, ((ev: FakeClick) => void)[]> = {}
  const document = {
    currentScript: { src: 'https://analyticshq.org/script.js', getAttribute: (name: string) => ({ 'data-site': 'site123' } as Record<string, string>)[name] ?? null },
    referrer: '',
    addEventListener: (type: string, fn: (ev: FakeClick) => void) => { (listeners[type] ??= []).push(fn) },
  }
  const window = { addEventListener: () => {} }
  const location = { href: 'https://fan.example/tour', origin: 'https://fan.example', pathname: '/tour', search: '', hostname: 'fan.example' }
  const fetch = (_url: string, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))) }
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', 'location', 'navigator', 'history', 'fetch', source)(
    document, window, location, {}, { pushState() {} }, fetch,
  )
  return {
    sent,
    click: (target: FakeElement) => listeners.click?.forEach(fn => fn({ type: 'click', target: dom(target) })),
  }
}

describe('data-analyticshq-event', () => {
  test('sends the named event, with the other attributes as properties', () => {
    const { sent, click } = load()
    const link = element('a', {
      'href': 'https://tickets.example/show/1',
      'data-analyticshq-event': 'Ticket click',
      'data-analyticshq-city': 'Phoenix, AZ',
      'data-analyticshq-venue': 'Desert Ridge Improv',
    })
    click(element('span', {}, link))

    expect(sent.slice(1)).toEqual([expect.objectContaining({
      s: 'site123',
      e: 'Ticket click',
      p: { city: 'Phoenix, AZ', venue: 'Desert Ridge Improv', url: 'https://tickets.example/show/1' },
    })])
  })

  test('replaces Outbound Link for a tagged link, so one click is one event', () => {
    const { sent, click } = load()
    click(element('a', { 'href': 'https://tickets.example/', 'data-analyticshq-event': 'Ticket click' }))

    expect(sent.slice(1).map(event => event.e)).toEqual(['Ticket click'])
  })

  test('works on an element that is not a link', () => {
    const { sent, click } = load()
    click(element('button', { 'data-analyticshq-event': 'Play special', 'data-analyticshq-video': 'my-struggle' }))

    expect(sent.slice(1)).toEqual([expect.objectContaining({ e: 'Play special', p: { video: 'my-struggle' } })])
  })

  test('leaves an untagged outbound link as Outbound Link', () => {
    const { sent, click } = load()
    click(element('a', { href: 'https://elsewhere.example/' }))

    expect(sent.slice(1)).toEqual([expect.objectContaining({ e: 'Outbound Link', p: { url: 'https://elsewhere.example/' } })])
  })
})
