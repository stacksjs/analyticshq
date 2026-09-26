/**
 * No `any`, anywhere in the app.
 *
 * The app used to read the signed-in user as `(user as any).name`, raw query
 * rows as `any[]`, and config through `as any`. Each one switched the compiler
 * off at exactly the point it had something to say, and taking them out found
 * real defects it had been hiding: `response.html` (a method the response
 * factory does not have) on every failed social sign-in, a `redactKey` that was
 * re-exported but never imported, a default storage disk named `'bun'` that no
 * disk is called, and social sign-in writing three columns that no migration
 * ever created.
 *
 * Rows are `Record<string, unknown>` read field by field (app/Support/rows.ts),
 * the user is typed by `types/user.d.ts`, and anything genuinely unknown is
 * `unknown` and narrowed. This pins that, and pins tsconfig to the whole app:
 * it used to include three directories, so most of this code was never
 * type-checked at all, and CI's `tsc --noEmit` passed over it.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const DIRS = ['app', 'routes', 'config', 'scripts', 'tests', 'types', 'resources', 'cloud']
const SELF = relative(ROOT, import.meta.path)

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      out.push(...files(path))
    else if (/\.(?:ts|stx)$/.test(name))
      out.push(path)
  }
  return out
}

/** The code of a file: comments removed, and for a template only its scripts. */
function code(path: string): string {
  let src = readFileSync(path, 'utf8')
  if (path.endsWith('.stx'))
    src = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

// Built from parts so this file does not match itself.
const ANY = 'any'
const TYPE_POSITION = new RegExp([
  `\\bas\\s+${ANY}\\b`, // as any
  `:\\s*${ANY}\\b`, // x: any, (): any
  `<${ANY}>`, // Promise<any>
  `\\b${ANY}\\[\\]`, // any[]
  `[<,]\\s*${ANY}\\s*[,>]`, // Record<string, any>
  `=>\\s*${ANY}\\b`, // () => any
  `\\|\\s*${ANY}\\b`, // X | any
].join('|'))
const LINT_ESCAPE = new RegExp(`no-explicit-${ANY}`)

describe('no any', () => {
  const sources = DIRS.flatMap(d => files(join(ROOT, d))).filter(p => relative(ROOT, p) !== SELF)

  test('finds the app', () => {
    expect(sources.length).toBeGreaterThan(200)
  })

  test('no source file types anything as any', () => {
    const offenders: string[] = []
    for (const path of sources) {
      code(path).split('\n').forEach((line, i) => {
        if (TYPE_POSITION.test(line))
          offenders.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  test('and none switches the lint rule off to get one in', () => {
    const offenders = sources.filter(p => LINT_ESCAPE.test(readFileSync(p, 'utf8'))).map(p => relative(ROOT, p))
    expect(offenders).toEqual([])
  })
})

describe('the type check covers the app', () => {
  const tsconfig = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')

  test('every source directory is included', () => {
    for (const dir of DIRS)
      expect(tsconfig).toContain(`"${dir}/**/*.ts"`)
  })

  test('none of them is excluded', () => {
    const exclude = tsconfig.slice(tsconfig.indexOf('"exclude"'))
    for (const dir of DIRS)
      expect(exclude).not.toContain(`"${dir}/**"`)
  })
})
