import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(import.meta.dir, '../../database/migrations/0000000053-create-email-subscriber-tables.sql'),
  'utf8',
)

describe('email subscriber migration', () => {
  it('creates both tables needed by SubscriberEmailAction', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "subscribers"')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "subscriber_emails"')
    expect(migration.indexOf('"subscribers"')).toBeLessThan(migration.indexOf('"subscriber_emails"'))
  })

  it('keeps subscriber identity and lookup fields unique', () => {
    expect(migration).toContain('"subscribers_email_unique"')
    expect(migration).toContain('"subscribers_uuid_unique"')
    expect(migration).toContain('"subscriber_emails_uuid_unique"')
  })

  it('connects subscriber emails to their subscriber', () => {
    expect(migration).toContain('"subscriber_id" bigint REFERENCES "subscribers"("id")')
  })
})
