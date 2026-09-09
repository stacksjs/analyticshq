/**
 * Reading Fathom's export out of the zip Fathom actually hands over.
 *
 * Two kinds of test, and both are here for a reason.
 *
 * The first reads `tests/fixtures/fathom-export.zip`, which is the checked-in
 * `fathom-export` folder zipped by /usr/bin/zip - a real archiver, not this
 * suite's idea of one - and requires that every file come back byte for byte
 * identical to the loose fixture beside it. That is the only assertion that can
 * catch an offset this module reads from the wrong place, because a hand-built
 * zip written by the same person who wrote the parser agrees with the parser by
 * construction.
 *
 * The second builds zips field by field, because the shapes that break an
 * unzipper are exactly the ones no ordinary export contains: a stored entry, an
 * entry whose sizes live only in the central directory, a truncated file, an
 * entry that lies about how big it inflates to. `zipOf` below is deliberately
 * literal about the layout so that a test asserting "the local header disagrees
 * with the directory" can actually make that happen.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { FATHOM_FILES, FATHOM_MAX_UPLOAD_BYTES, readFathomExport } from '../../app/Analytics/fathom-import'
import { FATHOM_MAX_ZIP_BYTES, readFathomZip } from '../../app/Analytics/fathom-zip'

const ROOT = join(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p))
const fixture = (name: string) => read(join('tests/fixtures/fathom-export', name)).toString('utf8')

interface Entry {
  name: string
  /** The file's real content. Compressed with `method` unless `raw` overrides. */
  data?: string | Buffer
  /** 0 stored, 8 deflate, anything else to test the refusal. */
  method?: number
  /** General purpose flags: 0x1 encrypted, 0x8 sizes in a data descriptor. */
  flags?: number
  /** What the CENTRAL DIRECTORY claims the entry inflates to, if not the truth. */
  declaredSize?: number
  /** Bytes to store instead of compressing `data`, for a deliberately bad entry. */
  raw?: Buffer
}

/**
 * A zip, written the long way.
 *
 * Local headers, then the central directory, then the end record. Sizes and the
 * CRC go in both places; a test that wants them to disagree passes `flags: 0x8`
 * (data descriptor), which zeroes them in the local header only, exactly as a
 * streaming archiver does.
 */
function zipOf(entries: Entry[], opts: { comment?: string, count?: number, cdOffset?: number } = {}): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const content = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8')
    const method = e.method ?? 8
    const flags = e.flags ?? 0
    const body = e.raw ?? (method === 8 ? deflateRawSync(content) : content)
    const sum = crc32(content)
    const streamed = (flags & 0x8) !== 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(streamed ? 0 : sum, 14)
    local.writeUInt32LE(streamed ? 0 : body.length, 18)
    local.writeUInt32LE(streamed ? 0 : content.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014B50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(sum, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(e.declaredSize ?? content.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += 30 + name.length + body.length
  }

  const body = Buffer.concat(locals)
  const dir = Buffer.concat(central)
  const comment = Buffer.from(opts.comment ?? '', 'utf8')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054B50, 0)
  eocd.writeUInt16LE(opts.count ?? entries.length, 8)
  eocd.writeUInt16LE(opts.count ?? entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(opts.cdOffset ?? body.length, 16)
  eocd.writeUInt16LE(comment.length, 20)
  return Buffer.concat([body, dir, eocd, comment])
}

/** The refusal text, or '' when the read succeeded. Keeps the assertions short. */
function refusal(result: ReturnType<typeof readFathomZip>): string {
  return 'error' in result ? result.error : ''
}

describe('a real zip from a real archiver', () => {
  const bytes = read('tests/fixtures/fathom-export.zip')
  const result = readFathomZip(new Uint8Array(bytes))

  test('every file the importer reads comes back byte for byte', () => {
    expect(refusal(result)).toBe('')
    if ('error' in result)
      return
    for (const name of FATHOM_FILES)
      expect(result.files.get(name)).toBe(fixture(name))
    expect([...result.files.keys()].sort()).toEqual([...FATHOM_FILES].sort())
  })

  test('the folder Fathom wraps the export in is stripped from the names', () => {
    if ('error' in result)
      throw new Error(result.error)
    // The archive really does carry the folder, so this is not a hypothetical.
    expect(bytes.toString('latin1')).toContain('Dashboard_Export_2026-09-08/Pages.csv')
    for (const name of result.names)
      expect(name).not.toContain('/')
  })

  test('the files that are not read are still named, so the warning can name them', () => {
    if ('error' in result)
      throw new Error(result.error)
    for (const name of ['Referrers.csv', 'Entry_Pages.csv', 'Events.csv', 'UTM_Source.csv'])
      expect(result.names).toContain(name)
    // Named but not read: the map holds only what the importer parses.
    expect(result.files.has('Referrers.csv')).toBe(false)
  })

  test('the zip and the loose folder produce the same export and the same notes', () => {
    if ('error' in result)
      throw new Error(result.error)
    const loose = new Map(FATHOM_FILES.map(name => [name, fixture(name)]))
    const fromLoose = readFathomExport(new Map([
      ...loose,
      // The loose reading sees the whole folder, ignored files included, which
      // is what the zip's `names` stands in for.
      ...['Referrers.csv', 'Entry_Pages.csv', 'Exit_Pages.csv', 'Events.csv', 'UTM_Campaign.csv', 'UTM_Content.csv', 'UTM_Medium.csv', 'UTM_Source.csv', 'UTM_Term.csv'].map(n => [n, fixture(n)] as [string, string]),
    ]))
    const fromZip = readFathomExport(result.files, result.names)
    if ('error' in fromLoose || 'error' in fromZip)
      throw new Error('the fixture should read cleanly both ways')
    expect(fromZip.export).toEqual(fromLoose.export)
    expect(fromZip.notes).toEqual(fromLoose.notes)
    expect(fromZip.notes.ignored.length).toBeGreaterThan(0)
  })
})

describe('the shapes an ordinary export never has', () => {
  const summary = 'Range,2026-09-02 00:00:00 to 2026-09-08 16:02:04 (UTC)\n'

  test('a stored entry is read without inflating it', () => {
    const r = readFathomZip(new Uint8Array(zipOf([{ name: 'Summary.csv', data: summary, method: 0 }])))
    if ('error' in r)
      throw new Error(r.error)
    expect(r.files.get('Summary.csv')).toBe(summary)
  })

  test('an entry whose sizes live only in the central directory is read', () => {
    // A streaming archiver writes zeroes into the local header and the real
    // figures into the directory. Reading the sizes from the local copy would
    // slice zero bytes here and return an empty file that parses as an empty
    // export - a silent wrong answer, not an error.
    const r = readFathomZip(new Uint8Array(zipOf([{ name: 'Summary.csv', data: summary, flags: 0x8 }])))
    if ('error' in r)
      throw new Error(r.error)
    expect(r.files.get('Summary.csv')).toBe(summary)
  })

  test('a byte order mark is dropped, as the browser dropped it before', () => {
    const r = readFathomZip(new Uint8Array(zipOf([{ name: 'Summary.csv', data: `﻿${summary}` }])))
    if ('error' in r)
      throw new Error(r.error)
    expect(r.files.get('Summary.csv')).toBe(summary)
  })

  test('the end record is found behind a trailing comment', () => {
    const r = readFathomZip(new Uint8Array(zipOf([{ name: 'Pages.csv', data: 'a\n' }], { comment: 'x'.repeat(4000) })))
    expect(refusal(r)).toBe('')
  })

  test('a duplicate name is read once, and the first one wins', () => {
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'a/Pages.csv', data: 'first\n' },
      { name: 'b/Pages.csv', data: 'second\n' },
    ])))
    if ('error' in r)
      throw new Error(r.error)
    expect(r.files.get('Pages.csv')).toBe('first\n')
    expect(r.names.filter(n => n === 'Pages.csv')).toHaveLength(1)
  })

  test('a directory entry is not mistaken for a file', () => {
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'Dashboard_Export/', data: '' },
      { name: 'Dashboard_Export/Pages.csv', data: 'a\n' },
    ])))
    if ('error' in r)
      throw new Error(r.error)
    expect(r.names).toEqual(['Pages.csv'])
  })

  test('a file the importer does not read is never inflated', () => {
    // Its bytes are garbage. Reading it would throw; naming it must not.
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'Pages.csv', data: 'a\n' },
      { name: 'Referrers.csv', data: 'x'.repeat(500), raw: Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]) },
    ])))
    if ('error' in r)
      throw new Error(r.error)
    expect(r.names).toContain('Referrers.csv')
    expect(r.files.has('Referrers.csv')).toBe(false)
  })
})

describe('what it refuses', () => {
  const NOT_A_ZIP = /not a zip we can read/

  test('something that is not a zip at all', () => {
    expect(refusal(readFathomZip(new TextEncoder().encode('path,visitors\n/,3\n')))).toMatch(NOT_A_ZIP)
  })

  test('a file too short to hold an end record', () => {
    expect(refusal(readFathomZip(new Uint8Array([0x50, 0x4B])))).toMatch(NOT_A_ZIP)
  })

  test('a zip whose central directory was cut off', () => {
    const whole = zipOf([{ name: 'Pages.csv', data: 'a\n' }])
    // Keep the end record, point it past the end of what is left.
    const cut = Buffer.concat([whole.subarray(0, whole.length - 22 - 46), whole.subarray(whole.length - 22)])
    expect(refusal(readFathomZip(new Uint8Array(cut)))).toMatch(NOT_A_ZIP)
  })

  test('a zip whose entry data was cut off', () => {
    const whole = zipOf([{ name: 'Pages.csv', data: 'a'.repeat(400) }])
    const eocd = whole.subarray(whole.length - 22)
    const dirStart = eocd.readUInt32LE(16)
    // Drop the last few bytes of the compressed data, leaving the directory
    // pointing at a length the file no longer has.
    const cut = Buffer.concat([whole.subarray(0, dirStart - 5), whole.subarray(dirStart)])
    expect(refusal(readFathomZip(new Uint8Array(cut)))).toMatch(NOT_A_ZIP)
  })

  test('the zip64 sentinels, which a Fathom export never reaches', () => {
    const whole = zipOf([{ name: 'Pages.csv', data: 'a\n' }], { count: 0xFFFF })
    expect(refusal(readFathomZip(new Uint8Array(whole)))).toMatch(NOT_A_ZIP)
  })

  test('a compression method nothing in a Fathom export uses', () => {
    // 12 is bzip2. Refused rather than half-read.
    expect(refusal(readFathomZip(new Uint8Array(zipOf([{ name: 'Pages.csv', data: 'a\n', method: 12 }]))))).toMatch(NOT_A_ZIP)
  })

  test('an empty zip, which is not the download they meant to send', () => {
    expect(refusal(readFathomZip(new Uint8Array(zipOf([]))))).toMatch(/zip is empty/)
  })

  test('a password protected entry, before trying to inflate it', () => {
    expect(refusal(readFathomZip(new Uint8Array(zipOf([{ name: 'Pages.csv', data: 'a\n', flags: 0x1 }]))))).toMatch(/password protected/)
  })

  test('an encrypted file the importer does not read is not a reason to refuse', () => {
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'Pages.csv', data: 'a\n' },
      { name: 'Events.csv', data: 'a\n', flags: 0x1 },
    ])))
    expect(refusal(r)).toBe('')
  })

  test('a zip past the byte ceiling, before it is parsed', () => {
    const r = readFathomZip(new Uint8Array(FATHOM_MAX_ZIP_BYTES + 1))
    expect(refusal(r)).toMatch(/larger than 5 MB/)
    expect('error' in r && r.tooLarge).toBe(true)
  })

  test('an export whose declared size is past the ceiling, before inflating any of it', () => {
    // Declared, not actual: a bomb is refused on what the directory claims, so
    // nothing is expanded in order to find out it was too big.
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'Pages.csv', data: 'a\n', declaredSize: FATHOM_MAX_UPLOAD_BYTES + 1 },
    ])))
    expect(refusal(r)).toMatch(/more than 5 MB of CSV once unzipped/)
    expect('error' in r && r.tooLarge).toBe(true)
  })

  test('an entry that lies about its size and inflates past the ceiling', () => {
    // The declared figure gets it past the check above; maxOutputLength stops it
    // anyway, which is the difference between a ceiling and a suggestion.
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'Pages.csv', data: 'a'.repeat(FATHOM_MAX_UPLOAD_BYTES + 1000), declaredSize: 10 },
    ])))
    expect(refusal(r)).toMatch(/could not be unzipped/)
  })

  test('an entry whose compressed bytes are damaged', () => {
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'Pages.csv', data: 'a'.repeat(100), raw: Buffer.from([0xFF, 0x00, 0xFF, 0x00, 0xFF]) },
    ])))
    expect(refusal(r)).toMatch(/could not be unzipped/)
  })

  test('stored files that together pass the ceiling, however they are lied about', () => {
    // Stored entries never reach inflateRawSync, so nothing but the two ceilings
    // stands between them and memory. Both are asserted at once on purpose: an
    // uncompressed entry costs its full size in the zip as well, so while
    // FATHOM_MAX_ZIP_BYTES equals FATHOM_MAX_UPLOAD_BYTES it is arithmetically
    // undecidable which one refuses this, and pinning either sentence here would
    // pin that coincidence rather than the behaviour.
    const half = 'a'.repeat(Math.floor(FATHOM_MAX_UPLOAD_BYTES * 0.6))
    const r = readFathomZip(new Uint8Array(zipOf([
      { name: 'Pages.csv', data: half, method: 0, declaredSize: 10 },
      { name: 'Summary.csv', data: half, method: 0, declaredSize: 10 },
    ])))
    expect(refusal(r)).toMatch(/5 MB/)
    expect('error' in r && r.tooLarge).toBe(true)
  })
})
