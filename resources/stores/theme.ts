/**
 * Theme store — the single source of truth for light/dark.
 *
 * HOW THIS FILE IS LOADED (store-loader contract — it is not a normal module):
 *   - resources/stores/ *.ts, top level only, non-recursive.
 *   - Every single-line `import ... from '...'` is DELETED before transpile, so
 *     this file imports nothing. A value import here would be stripped and throw
 *     ReferenceError at runtime with no build error.
 *   - `export` is stripped and all store files are concatenated into ONE shared
 *     IIFE, so every top-level name here must be unique across the directory —
 *     including against session.ts.
 *   - `defineStore`, `state`, `derived` and `useColorMode` are runtime globals on
 *     `window.stx`; never import them.
 *
 * Why a store rather than a per-page signal: `window.stx._stores` is the only
 * client state in stx that survives an SPA navigation. cleanupContainer disposes
 * per-element effects on every fragment swap but never touches _stores, and
 * defineStore is idempotent, so re-running this bundle after a swap is a no-op.
 *
 * ## What this does NOT own
 *
 * The palette. resources/layouts/app.stx has had light and dark token sets and
 * `[data-theme]` overrides since before this file existed, which is why the app
 * already tracked the OS setting. All that was missing was something to write
 * the attribute, and that is the whole job here.
 *
 * The pre-paint bootstrap either — `config/ui.ts` app.colorMode declares it, and
 * stx injects a render-blocking snippet above the stylesheet. The options there
 * and the options here must stay identical: if they disagree on the storage key
 * or the attribute, the boot script applies one thing, hydration applies
 * another, and the flash this is meant to prevent comes back.
 *
 * Nor the `.dark` class. `darkClass` in that same config applies it alongside the
 * attribute, which is what makes crosswind's `dark:` utilities work. loghq's
 * equivalent store does that by hand inside its subscribe callback because it
 * predates the config option; this does not need to.
 */

/**
 * Registered immediately, like session.ts beside it — NOT deferred to
 * DOMContentLoaded the way loghq's equivalent store is.
 *
 * That guard exists in loghq because 24 of its pages hand-write their own
 * `<!DOCTYPE>`, which skips ensureDocumentShell and lands the store bundle above
 * the signals runtime; calling `defineStore` there throws and takes the whole
 * concatenated IIFE down. Every layout in this app is a fragment — auth.stx and
 * marketing.stx both say so in their first lines and warn against writing a
 * doctype "even inside a comment" — so the runtime is always present first.
 *
 * Copying the guard across would have been worse than useless here. The dashboard
 * calls `useStore('theme')` at module scope, so a deferred registration would
 * resolve to nothing on first paint, while session.ts sitting immediately beside
 * it would be fine — an inconsistency with no upside.
 *
 * If a page ever does hand-write a shell, this file and session.ts both need the
 * guard, together. One without the other still dies, because they share an IIFE.
 */
defineStore('theme', () => {
  // useColorMode owns persistence, the prefers-color-scheme listener, the
  // cross-tab storage listener and transition suppression.
  //
  // These options are duplicated in config/ui.ts app.colorMode by necessity —
  // the boot script runs before any of this exists and cannot read from here.
  // Change one, change the other.
  const cm = useColorMode({
    storageKey: 'analyticshq_theme',
    attribute: 'data-theme',
  })

  // cm.mode and cm.isDark are plain getters, NOT signals. Reading one inside a
  // directive registers no dependency, so a binding on it would render once
  // and then never update — the toggle would appear to do nothing while the
  // attribute changed underneath it. Mirror into a real signal via subscribe.
  const mode = state<'light' | 'dark'>(cm.mode)

  // The unsubscribe is deliberately discarded: this subscription's lifetime is
  // the page's. The store outlives fragment swaps by design.
  cm.subscribe((resolved) => {
    mode.set(resolved)
  })

  return {
    mode,
    isDark: derived(() => mode() === 'dark'),
    toggle: () => cm.toggle(),
  }
})
