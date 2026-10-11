import { describe, expect, test } from 'bun:test'
import theme from '../../config/crosswind'
// The installed STX package does not export these subpaths by bare specifier.
import { loadCssEngine } from '../../node_modules/@stacksjs/stx/dist/dev-server/ts-css.js'
import { SEMANTIC_TOKENS, SHAPE_TOKENS } from '../../node_modules/@stacksjs/stx/dist/theme-tokens.js'
import { mergeCssConfig } from '../../node_modules/@stacksjs/stx/dist/ts-css-config.js'

const colors: Record<string, string> = theme.theme.extend.colors
const radii: Record<string, string> = theme.theme.extend.borderRadius

describe('component palette contract', () => {
  test('maps every installed library color and shape role', () => {
    expect(Object.keys(SEMANTIC_TOKENS).filter(role => !colors[role])).toEqual([])
    expect(Object.keys(SHAPE_TOKENS).filter(role => !radii[role])).toEqual([])
  })

  test('the real STX/Crosswind merge emits app values, not stock role fallbacks', async () => {
    const engine = await loadCssEngine()
    if (!engine) throw new Error('The installed STX CSS engine is required')
    const generator = new engine.CSSGenerator(mergeCssConfig(engine.defaultConfig || engine.config, theme).config)
    for (const role of Object.keys(SEMANTIC_TOKENS)) generator.generate(`bg-${role}`)
    for (const role of Object.keys(SHAPE_TOKENS)) generator.generate(`rounded-${role}`)
    const css = generator.toCSS(false, false)
    for (const role of Object.keys(SEMANTIC_TOKENS)) {
      expect(css).toContain(`.bg-${role} {\n  background-color: ${colors[role]};`)
    }
    for (const role of Object.keys(SHAPE_TOKENS)) {
      expect(css).toContain(`.rounded-${role} {\n  border-radius: ${radii[role]};`)
    }
    expect(css).not.toContain('var(--stx-')
  })

  test('content is a surface, and status ink has matching palette fallbacks', () => {
    expect(colors.content).toBe('var(--panel, var(--surface))')
    expect(colors.link).toBe('var(--accent-text, var(--accent))')
    expect(colors['accent-ink']).toBe('var(--accent-ink)')
    expect(colors.danger).toBe('var(--bad, var(--danger))')
    expect(colors.success).toBe('var(--good, var(--accent))')
    expect(colors.warning).toBe('var(--warn, var(--text-2, var(--muted)))')
  })
})
