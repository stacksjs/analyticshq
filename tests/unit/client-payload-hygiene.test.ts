import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const VIEWS = join(import.meta.dir, '../../resources/views')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return walk(path)
    return path.endsWith('.stx') ? [path] : []
  })
}

// stx's server->client data bridge inlines a server binding into the compiled
// <script client> block only when that block does not itself declare the
// name. The check is textual, not scoped: a `const range = ...` inside a
// nested function counts, the bridge then leaves the whole block without
// `range`, and a top-level use such as switchSite's throws ReferenceError at
// click time. Nothing at compile time says so. Every name handed to
// defineClientPayload is therefore reserved throughout the client block.
describe('client payload hygiene', () => {
  test('no <script client> block re-declares a name it receives through defineClientPayload', () => {
    const offenders: Record<string, string[]> = {}
    for (const file of walk(VIEWS)) {
      const source = readFileSync(file, 'utf8')
      const server = [...source.matchAll(/<script\s+server[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n')
      const payload = server.match(/defineClientPayload\(\s*\{([\s\S]*?)\}\s*\)/)
      if (!payload)
        continue
      const names = payload[1].split(',').map(entry => entry.split(':')[0].trim()).filter(Boolean)
      const client = [...source.matchAll(/<script\s+client[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n')
      const shadowed = names.filter(name => new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`).test(client))
      if (shadowed.length)
        offenders[relative(VIEWS, file)] = shadowed
    }
    expect(offenders).toEqual({})
  })
})
