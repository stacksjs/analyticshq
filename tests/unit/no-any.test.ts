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

/*
 * Directories the walk must not enter.
 *
 * `pantry` is a local toolchain install (Postgres and its dependencies): one
 * `.gitignore` entry, 6990 files, and not a single `.ts` or `.stx` among them.
 * In this app it sits at `config/pantry`, so the `config` scan below walked all
 * of it to find nothing -- and its `.bin/` holds 92 symlinks into a checkout
 * that no longer has those files, so the walk died on the first one with an
 * ENOENT out of `statSync` and took the whole file down with it. CI never sees
 * `pantry`, which is why this only ever failed on a developer's machine, and
 * why it cost an exit code rather than a build.
 */
const VENDORED = new Set(['pantry', 'node_modules'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (VENDORED.has(entry.name))
      continue
    const path = join(dir, entry.name)
    /*
     * Read the kind off the directory entry, not off a stat of the path: a
     * `readdirSync` entry already knows, so the common case costs no syscall
     * and cannot throw. Only a symlink needs resolving, because its own entry
     * says nothing about what it points at -- and if that target is gone, skip
     * the link instead of letting the error end the walk. There are no symlinks
     * at all under the other seven directories, so this branch exists for
     * `pantry`'s sake and for whatever the next local install leaves behind.
     */
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        directory = statSync(path).isDirectory()
      }
      catch {
        continue
      }
    }
    if (directory)
      out.push(...files(path))
    else if (/\.(?:ts|stx)$/.test(entry.name))
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
