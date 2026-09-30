import { describe, expect, it } from 'bun:test'
import { subdivisionName } from '../../app/Analytics/regions'

/**
 * The regions panel reads `PH-07` out of the database and has to print
 * something a person recognises. These pin the lookup, and the tie-break it
 * needs, because `subdivisions.json` is regenerated from DB-IP and a rebuild
 * that changed either would quietly change what every row says.
 */
describe('subdivisionName', () => {
  it('names the codes the panel actually shows', () => {
    expect(subdivisionName('US-CA')).toBe('California')
    expect(subdivisionName('PH-07')).toBe('Central Visayas')
    expect(subdivisionName('GB-ENG')).toBe('England')
  })

  it('keeps the accented spelling when the table carries both', () => {
    // DB-IP has 'Baden-Wurttemberg' and 'Baden-Württemberg' against DE-BW, and
    // the obvious tie-break — shortest wins — picks the mangled one.
    expect(subdivisionName('DE-BW')).toBe('Baden-Württemberg')
  })

  it('prefers the plainest form when neither spelling is accented', () => {
    expect(subdivisionName('DE-BE')).toBe('Berlin')
    expect(subdivisionName('PH-05')).toBe('Bicol')
  })

  it('answers null rather than guessing, so the row keeps its code', () => {
    // A real place the table does not know. `PH-XX` on screen is honest; an
    // invented name is not.
    expect(subdivisionName('PH-XX')).toBeNull()
    expect(subdivisionName('US')).toBeNull()
    expect(subdivisionName('')).toBeNull()
    expect(subdivisionName(null)).toBeNull()
    expect(subdivisionName('nonsense')).toBeNull()
  })

  it('covers enough of the table to be worth having', () => {
    // A guard on the data rather than the code: a regenerated file that lost
    // most of its countries would still pass every assertion above.
    const named = ['US-CA', 'US-NY', 'GB-ENG', 'DE-BY', 'FR-IDF', 'JP-13', 'AU-NSW', 'PH-07', 'CA-ON', 'BR-SP']
    for (const code of named)
      expect(subdivisionName(code)).toBeTruthy()
  })
})
