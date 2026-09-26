/**
 * Every column a migration adds is declared by its model.
 *
 * `buddy migrate` runs a schema differ that compares the live tables against
 * the models and drops any column the models do not name. So a raw
 * `ALTER TABLE ... ADD COLUMN` without a matching model attribute is a column
 * that the NEXT deploy deletes, data and all.
 *
 * That is not hypothetical. Migrations 0000000045 (revenue) and 0000000046
 * (custom domains) added seven columns their models never declared, a deploy
 * dropped every one from production, and GET /api/sites, which selects
 * sites.currency, answered 500 for every signed-in user until it was traced.
 * Region and city geo got this right by hand (region-geo.test.ts pins those
 * two); this pins it for every table that has a model, so the next migration
 * cannot repeat it.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const MIGRATIONS = join(ROOT, 'database/migrations')
const MODELS = join(ROOT, 'app/Models')

/** table name -> model source, for every model that names its table. */
function modelsByTable(): Map<string, { file: string, src: string }> {
  const out = new Map<string, { file: string, src: string }>()
  for (const file of readdirSync(MODELS).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(join(MODELS, file), 'utf8')
    const table = /table:\s*'([a-z_]+)'/.exec(src)?.[1]
    if (table)
      out.set(table, { file, src })
  }
  return out
}

/** Every (table, column) a migration adds and no later migration drops. */
function addedColumns(): Array<{ table: string, column: string, migration: string }> {
  const added: Array<{ table: string, column: string, migration: string }> = []
  const dropped = new Set<string>()
  for (const migration of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, migration), 'utf8').replace(/--[^\n]*/g, '')
    for (const m of sql.matchAll(/ALTER TABLE\s+"?(\w+)"?\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?/gi))
      added.push({ table: m[1], column: m[2], migration })
    for (const m of sql.matchAll(/ALTER TABLE\s+"?(\w+)"?\s+DROP COLUMN(?:\s+IF EXISTS)?\s+"?(\w+)"?/gi))
      dropped.add(`${m[1]}.${m[2]}`)
  }
  return added.filter(a => !dropped.has(`${a.table}.${a.column}`))
}

describe('the schema differ cannot drop a migrated column', () => {
  const models = modelsByTable()
  const columns = addedColumns().filter(c => models.has(c.table))

  test('the scan finds the columns it is meant to guard', () => {
    // A regex that silently matched nothing would pass the test below forever.
    expect(columns.length).toBeGreaterThanOrEqual(9)
    expect(columns.some(c => c.table === 'sites' && c.column === 'currency')).toBe(true)
  })

  test('every added column is declared by its model', () => {
    const missing = columns
      .filter(c => !new RegExp(`^\\s+${c.column}\\s*:`, 'm').test(models.get(c.table)!.src))
      .map(c => `${c.table}.${c.column} (added by ${c.migration}, not declared in app/Models/${models.get(c.table)!.file})`)
    expect(missing).toEqual([])
  })

  test('the dropped columns are restored by a migration', () => {
    const sql = readFileSync(join(MIGRATIONS, '0000000055-restore-dropped-revenue-and-domain-columns.sql'), 'utf8')
    for (const col of ['"conversions" ADD COLUMN IF NOT EXISTS "amount_minor" bigint', '"sites" ADD COLUMN IF NOT EXISTS "currency" varchar(3)', '"sites" ADD COLUMN IF NOT EXISTS "custom_domain" varchar(255)'])
      expect(sql).toContain(col)
    for (const stmt of sql.split(';').filter(s => /ALTER TABLE|CREATE (UNIQUE )?INDEX/.test(s)))
      expect(stmt).toMatch(/IF NOT EXISTS/)
  })
})

describe('the schema differ cannot narrow a column either', () => {
  // Without `type`, the differ infers a column from its validation rule: a
  // number becomes `integer`, an unbounded string `varchar(255)`. These three
  // are `bigint` and `text` in production, and stacks 0.75 planned to change
  // them to the inferred types, which would overflow money amounts and
  // truncate event properties. The deploy's destructive-change gate refused it.
  const pinned: Array<[string, string, string]> = [
    ['Goal.ts', 'default_amount_minor', 'bigint'],
    ['Conversion.ts', 'amount_minor', 'bigint'],
    ['CustomEvent.ts', 'properties', 'text'],
    // text in production; its max(512) rule would otherwise infer varchar(512).
    ['Subscription.ts', 'type', 'text'],
    // Floats, not the integer a number rule infers. An integer column floors
    // CLS to 0, which is why web_vitals had no model until it could say so.
    ['WebVital.ts', 'value', 'double'],
    ['SearchQuery.ts', 'position', 'double'],
  ]

  for (const [file, column, type] of pinned) {
    test(`${column} is declared ${type}`, () => {
      const src = readFileSync(join(MODELS, file), 'utf8')
      expect(src).toMatch(new RegExp(`\\b${column}: \\{[^}]*type: '${type}'`))
    })
  }
})
