import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_EVENT_PROPERTIES_BYTES, serializeEventProperties } from '../../app/Analytics/event-properties'

describe('event property serialization', () => {
  test('preserves structured metadata well beyond the old 255-character column', () => {
    const properties = {
      campaign: 'spring-launch',
      notes: 'measured-context-'.repeat(700),
    }
    const serialized = serializeEventProperties('Signup', properties)

    expect(serialized).toBe(JSON.stringify(properties))
    expect(serialized!.length).toBeGreaterThan(10_000)
  })

  test('keeps the complete URL for reserved automatic events', () => {
    const url = `https://example.com/${'deep/path/'.repeat(900)}?source=campaign`
    const serialized = serializeEventProperties('Outbound Link', {
      ignored: 'does not split the aggregate',
      url,
    })

    expect(serialized).toBe(JSON.stringify({ url }))
    expect(JSON.parse(serialized!).url).toBe(url)
  })

  test('canonicalizes file downloads the same way', () => {
    expect(serializeEventProperties('File Download', {
      url: 'https://example.com/report.csv',
      arbitrary: true,
    })).toBe('{"url":"https://example.com/report.csv"}')
  })

  test('omits optional properties that exceed the UTF-8 byte budget', () => {
    const properties = { notes: 'é'.repeat(MAX_EVENT_PROPERTIES_BYTES) }

    expect(serializeEventProperties('Oversized', properties)).toBeNull()
  })

  test('omits values JSON cannot serialize', () => {
    expect(serializeEventProperties('Invalid', 1n)).toBeNull()
  })
})

describe('event property storage', () => {
  const root = join(import.meta.dir, '..', '..')

  test('upgrades existing PostgreSQL columns to text', () => {
    const migration = readFileSync(
      join(root, 'database/migrations/0000000052-widen-custom-event-properties.sql'),
      'utf8',
    )

    expect(migration).toContain('ALTER COLUMN "properties" TYPE text')
    expect(migration).toContain('USING "properties"::text')
  })

  test('the collector uses the bounded serializer without URL clipping', () => {
    const source = readFileSync(join(root, 'routes/analytics.ts'), 'utf8')

    expect(source).toContain('serializeEventProperties(event, body.p)')
    expect(source).not.toContain('while (props.length > 255')
    expect(source).not.toContain('widen custom_events.properties')
  })
})
