/**
 * Reading Fathom's dashboard export in the shape Fathom actually hands over: a
 * zip.
 *
 * The upload used to start with an instruction - unzip this, then select these
 * seven files out of the eighteen inside - which is the only step in the whole
 * migration the customer performs on our behalf rather than for a reason. The
 * zip goes to the server as base64 in the same JSON body the CSV text used, so
 * the request path is unchanged: no multipart, no FormData, no boundary. It is
 * also SMALLER on the wire than the text it replaces, because the files were
 * already compressed when Fathom made the zip and CSV compresses about tenfold;
 * the 5 MB ceiling now bounds the unzipped CSV, which is the thing this app has
 * to hold in memory, rather than the bytes that carried it.
 *
 * UNZIPPED HERE RATHER THAN IN THE BROWSER, and that is the whole reason this
 * file exists. A browser can inflate a deflate stream (`DecompressionStream`)
 * but cannot read the zip container around it, so the parsing below would have
 * had to live inline in `dashboard.stx`'s client block - and tsc cannot see
 * inside a .stx file, so every offset in it would be checked by nothing and
 * tested by nothing. In a real module the same code is typed and has
 * `tests/unit/fathom-zip.test.ts` behind it.
 *
 * ONLY THE FILES THE IMPORTER READS ARE INFLATED. `names` still reports every
 * entry the zip held, because `readFathomExport` names the ones it skipped -
 * referrers, entry and exit pages, events, UTM - and a customer who is told
 * nothing about them notices their other files vanished instead. Inflating all
 * eighteen to learn nine names would roughly double the work and the memory,
 * and Entry_Pages.csv and Exit_Pages.csv are each about the size of Pages.csv.
 *
 * Written against the zip format directly rather than with a library: the
 * fraction of it a Fathom export uses is the central directory, stored and
 * deflate, and none of the rest - no spanning, no encryption, no zip64. A
 * dependency for that is a dependency to keep, and an unzipper that accepts
 * every zip is a larger thing to have accepted an upload into than one that
 * refuses everything a Fathom export is not.
 */
import { inflateRawSync } from 'node:zlib'
import { FATHOM_FILES, FATHOM_MAX_UPLOAD_BYTES, fathomBasename } from './fathom-import'

/**
 * Zip bytes one upload may carry, before base64.
 *
 * The same number as the unzipped ceiling, and deliberately not derived from
 * it: this one bounds what has to be decoded and scanned before anything is
 * known about the contents, and 5 MB of zipped CSV is far more export than
 * `FATHOM_MAX_UPLOAD_BYTES` will accept once inflated. Whichever bites first,
 * both refusals say what to do about it.
 */
export const FATHOM_MAX_ZIP_BYTES = 5 * 1024 * 1024

/** Said by three of the refusals below, which are all "this is the wrong file". */
const NOT_A_ZIP = 'That file is not a zip we can read. Use the download button on your Fathom dashboard - it produces a zip named something like Dashboard_Export_2026-09-08.zip.'

/** Said by both ceilings, which a customer resolves the same way either way. */
const TOO_BIG = 'That export holds more than 5 MB of CSV once unzipped, which is more than one request can take. In Fathom, choose a shorter date range, download again, and import the pieces one after another. Each import adds to the last.'

const EOCD_SIG = 0x06054B50
const CD_SIG = 0x02014B50
const LOCAL_SIG = 0x04034B50
/** The zip comment is length-prefixed at the end, and its length field is u16. */
const MAX_COMMENT = 0xFFFF
/** Fixed part of an end-of-central-directory record. */
const EOCD_LEN = 22
/** Fixed part of a central directory entry, before name/extra/comment. */
const CD_LEN = 46
/** Fixed part of a local file header, before name/extra. */
const LOCAL_LEN = 30

/**
 * Why an upload was refused.
 *
 * `tooLarge` exists so the handler can answer 413 where the CSV path already
 * does and 400 everywhere else, without matching on the sentence. It is not on
 * the damaged-entry refusal below, which cannot tell a bomb from a bad file.
 */
export interface FathomZipRefusal {
  error: string
  tooLarge?: boolean
}

interface CentralEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  encrypted: boolean
}

/**
 * The end-of-central-directory record, which is the only fixed point in a zip.
 *
 * Searched backwards from the end because the record is last but is followed by
 * a comment of up to 64 KB, so its position is not known from the length.
 * Backwards also settles which record wins when a zip has been appended to
 * another file: the last one is the live directory.
 */
function findEocd(b: Buffer): number {
  const earliest = Math.max(0, b.length - EOCD_LEN - MAX_COMMENT)
  for (let i = b.length - EOCD_LEN; i >= earliest; i--) {
    if (b.readUInt32LE(i) === EOCD_SIG)
      return i
  }
  return -1
}

/**
 * Read a Fathom export out of zip bytes.
 *
 * Returns an error sentence rather than throwing, for the same reason
 * `readFathomExport` does: the caller is an HTTP handler that has to turn every
 * failure into something a customer can act on, and a thrown offset error is
 * not that.
 */
export function readFathomZip(bytes: Uint8Array): { files: Map<string, string>, names: string[] } | FathomZipRefusal {
  if (bytes.length > FATHOM_MAX_ZIP_BYTES)
    return { error: 'That zip is larger than 5 MB. In Fathom, choose a shorter date range, download again, and import the pieces one after another. Each import adds to the last.', tooLarge: true }

  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length < EOCD_LEN)
    return { error: NOT_A_ZIP }

  const eocd = findEocd(b)
  if (eocd < 0)
    return { error: NOT_A_ZIP }

  const count = b.readUInt16LE(eocd + 10)
  const cdOffset = b.readUInt32LE(eocd + 16)
  // Both fields are saturated when the real values live in a zip64 record. A
  // Fathom export reaches neither 65,535 files nor 4 GB, so this is a wrong
  // file rather than a format to support.
  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF)
    return { error: NOT_A_ZIP }
  if (cdOffset >= b.length)
    return { error: NOT_A_ZIP }

  const entries: CentralEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + CD_LEN > b.length || b.readUInt32LE(p) !== CD_SIG)
      return { error: NOT_A_ZIP }
    const flags = b.readUInt16LE(p + 8)
    const nameLen = b.readUInt16LE(p + 28)
    const extraLen = b.readUInt16LE(p + 30)
    const commentLen = b.readUInt16LE(p + 32)
    if (p + CD_LEN + nameLen > b.length)
      return { error: NOT_A_ZIP }
    entries.push({
      // Names are stored as UTF-8 when bit 11 is set and as CP437 otherwise.
      // Everything matched below is ASCII, where the two agree, so the flag is
      // not worth reading: a name the decode gets wrong is a name that was
      // never going to be one of the seven.
      name: b.toString('utf8', p + CD_LEN, p + CD_LEN + nameLen),
      method: b.readUInt16LE(p + 10),
      compressedSize: b.readUInt32LE(p + 20),
      uncompressedSize: b.readUInt32LE(p + 24),
      localOffset: b.readUInt32LE(p + 42),
      encrypted: (flags & 0x1) !== 0,
    })
    p += CD_LEN + nameLen + extraLen + commentLen
  }

  const names: string[] = []
  const wanted: CentralEntry[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    // Directory entries carry the trailing slash and no content. A zip built by
    // hand can also hold a second entry under a name already taken; the first
    // is the one read, so a crafted duplicate cannot make this inflate twice.
    if (e.name.endsWith('/'))
      continue
    const base = fathomBasename(e.name)
    if (!base || seen.has(base))
      continue
    seen.add(base)
    names.push(base)
    if ((FATHOM_FILES as readonly string[]).includes(base))
      wanted.push(e)
  }

  if (!names.length)
    return { error: 'That zip is empty. Use the download button on your Fathom dashboard, which produces a zip with Summary.csv and Pages.csv in it.' }
  if (wanted.some(e => e.encrypted))
    return { error: 'That zip is password protected, so we cannot read the files inside it. Download the export from Fathom again without a password.' }

  // Checked against the sizes the directory DECLARES before anything is
  // inflated, so a zip bomb is refused rather than expanded and then measured.
  // The declaration is not trusted afterwards either - `maxOutputLength` below
  // holds the same ceiling against an entry that lies about its size.
  const declared = wanted.reduce((n, e) => n + e.uncompressedSize, 0)
  if (declared > FATHOM_MAX_UPLOAD_BYTES)
    return { error: TOO_BIG, tooLarge: true }

  const files = new Map<string, string>()
  let used = 0
  for (const e of wanted) {
    if (e.localOffset + LOCAL_LEN > b.length || b.readUInt32LE(e.localOffset) !== LOCAL_SIG)
      return { error: NOT_A_ZIP }
    // The local header repeats the name and extra lengths and is allowed to
    // disagree with the central directory about them, so the data offset is
    // computed from the local copy. The SIZES are taken from the directory
    // instead: an entry written with a data descriptor (flag bit 3) carries
    // zeroes for them here and the real figures only in the directory.
    const nameLen = b.readUInt16LE(e.localOffset + 26)
    const extraLen = b.readUInt16LE(e.localOffset + 28)
    const start = e.localOffset + LOCAL_LEN + nameLen + extraLen
    const end = start + e.compressedSize
    if (end > b.length)
      return { error: NOT_A_ZIP }

    const room = FATHOM_MAX_UPLOAD_BYTES - used
    let out: Buffer
    if (e.method === 0) {
      out = b.subarray(start, end)
      if (out.length > room)
        return { error: TOO_BIG, tooLarge: true }
    }
    else if (e.method === 8) {
      try {
        out = inflateRawSync(b.subarray(start, end), { maxOutputLength: room })
      }
      catch {
        // Either the entry is corrupt or it inflates past what is left of the
        // ceiling. Both mean this upload is not going to become an import, and
        // neither is worth two sentences the customer has to tell apart.
        return { error: 'One of the files in that zip could not be unzipped, so the export is either damaged or larger than the 5 MB of CSV one import can take. Download it from Fathom again, choosing a shorter date range if it is a large site.' }
      }
    }
    else {
      return { error: NOT_A_ZIP }
    }

    used += out.length
    // TextDecoder rather than Buffer.toString: it drops a leading byte order
    // mark, which is what the browser's File.text() did on the path this
    // replaces, so a BOM-prefixed Summary.csv still parses its date range.
    files.set(fathomBasename(e.name), new TextDecoder().decode(out))
  }

  return { files, names }
}
