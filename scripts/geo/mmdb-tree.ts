/**
 * Every record in an MMDB file, once each.
 *
 * mmdb-lib's `Reader` answers one address at a time and has no public way to
 * enumerate records; a lookup per address would take days. So this reads the
 * search tree directly: its leaves are pointers into the data section, and
 * many addresses share one record, so the distinct pointers are the records.
 *
 * That needs two things `Reader` keeps private, its walker and its data-section
 * lookup. They are checked at run time rather than cast, so an mmdb-lib release
 * that renames either fails here, loudly, instead of producing an empty file.
 * Used only by the offline build scripts next to this one.
 */
import type { Response as MmdbResponse } from 'mmdb-lib'
import { readFileSync } from 'node:fs'
import { Reader } from 'mmdb-lib'
import type { GeoRecord } from '../../app/Analytics/geo'

/** A record as the City database stores it: ours, plus the place's centre. */
export interface PlaceRecord extends GeoRecord {
  location?: { latitude?: number, longitude?: number }
}

export interface MmdbTree {
  databaseType: string
  /** Every distinct data record. */
  records: () => Generator<PlaceRecord>
}

export function openTree(path: string): MmdbTree {
  const reader = new Reader<MmdbResponse>(readFileSync(path))
  const { nodeCount, nodeByteSize, databaseType } = reader.metadata
  // Seen as a plain object, so the private members are reached as unknowns
  // and checked, rather than through the class's declared surface.
  const internals: object = reader
  const walker = 'walker' in internals ? internals.walker : null
  const resolve = 'resolveDataPointer' in internals ? internals.resolveDataPointer : null
  if (typeof walker !== 'object' || walker === null || !('left' in walker) || !('right' in walker)
    || typeof walker.left !== 'function' || typeof walker.right !== 'function' || typeof resolve !== 'function') {
    throw new Error('mmdb-lib no longer exposes its tree walker: check scripts/geo/mmdb-tree.ts against the installed version')
  }
  const { left, right } = walker

  return {
    databaseType,
    * records() {
      const pointers = new Set<number>()
      for (let n = 0; n < nodeCount; n++) {
        const off = n * nodeByteSize
        for (const v of [Number(left(off)), Number(right(off))]) {
          if (v > nodeCount)
            pointers.add(v)
        }
      }
      for (const p of pointers) {
        const rec: unknown = resolve.call(reader, p)
        // The data section holds the same records `Reader.get` answers with,
        // which app/Analytics/geo.ts reads as a `GeoRecord` too.
        if (typeof rec === 'object' && rec !== null)
          yield rec as PlaceRecord
      }
    },
  }
}
