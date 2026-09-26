/**
 * Reading raw query rows without casting them.
 *
 * `db.unsafe` answers `Record<string, unknown>[]`: the driver knows the column
 * names only at run time, and Postgres hands a `COUNT(*)` back as a string. A
 * cast to the row shape the SQL "should" produce is a claim the compiler cannot
 * check. These read each field for what it is instead, so a column that comes
 * back null or as a string is handled rather than assumed away.
 */

/** One row as the driver returns it: column name to value. */
export type Row = Record<string, unknown>

/** A text column, or null when the value is missing. */
export function text(v: unknown): string | null {
  if (v == null)
    return null
  return typeof v === 'string' ? v : String(v)
}

/** A numeric column (counts arrive as strings from Postgres), 0 when unreadable. */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
