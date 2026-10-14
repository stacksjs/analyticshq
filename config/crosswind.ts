/**
 * Crosswind (utility CSS) — content globs for STX views.
 * @see https://github.com/cwcss/crosswind
 */

/*
 * ## Where the chrome below used to live, and why it moved
 *
 * resources/layouts/app.stx and resources/layouts/auth.stx each carried a
 * `<style>` block in `@head`: a `:root` palette, a `body` rule, `.wordmark`,
 * and the ten rules ThemeToggle.stx needs. The last twelve of those were
 * BYTE-IDENTICAL between the two files (checked by diffing the spans, not by
 * eye), and the palettes were two deliberately different sets under the same
 * token names.
 *
 * A `<style>` block in a `.stx` file is invisible to the extractor, cannot be
 * deduped or purged, and is the thing stx-standards rule 3 / §11.1 forbids;
 * §11.2 says the tokens belong here, exactly once. Both are now `preflights`
 * entries, which the render path prepends to the generated sheet -- so they
 * land inside the one `<style data-crosswind>` the SPA router preserves across
 * a fragment swap, instead of a `/_stx/style.*.css` file of their own.
 *
 * ## Why a preflight is the right vehicle and a shortcut is not
 *
 * Measured against the installed engine rather than assumed: `preflights` land
 * in `@layer tc-base`, and `shortcuts` emit an UNLAYERED `.name{…}` rule. An
 * unlayered rule beats a layered one at any specificity, and the generated
 * sheet is served AFTER public/marketing.css on every marketing page (verified
 * in the built output: /marketing.css at byte 2183 of dist/pricing.html, the
 * generated link at 2228).
 *
 * So for a class name public/marketing.css also claims -- `.btn`, `.panel`,
 * `.stat-label` -- the two vehicles do opposite things: a preflight LOSES to
 * marketing.css on the 28 marketing pages and applies everywhere else, while a
 * shortcut WINS and would repaint them. The layer is the page scoping, for
 * free. Nothing here shares a name with marketing.css, and the auth controls
 * that did are shortcuts under names it has no claim on (see `btn-accent`).
 *
 * ## Why the palettes are keyed off a meta tag
 *
 * One generated sheet serves every page, so `:root{…}` would put the app's
 * white `--panel` on the marketing pages too -- where the whole point of the
 * `var(--panel, var(--surface))` fallbacks in `theme.extend.colors` below is
 * that `--panel` is UNDEFINED and marketing.css's `--surface` answers instead.
 * Defining it would quietly turn every `bg-panel` on those pages white.
 *
 * stx emits `<meta name="stx-layout-group" content="…">` into `<head>` from
 * the layout's FILENAME, which is already what this app treats as the real
 * name of a layout group (see the comment at the top of each layout), and
 * stx-router keeps it fresh across navigations. It is also emitted at the very
 * top of `<head>` -- byte 219 of dist/dashboard.html, a kilobyte ahead of the
 * first stylesheet -- so the match is settled before anything paints. Keying
 * off `<main data-chrome>` instead would have left a frame where the palette
 * had not resolved yet, which on the dark auth pages is a white flash.
 *
 * `html:has(meta…)` is (0,2,1): it outranks the plain `:root` the rules below
 * would otherwise use, and the two groups are mutually exclusive, so neither
 * palette can reach the other's pages however the two blocks are ordered.
 */
const APP = 'html:has(meta[name="stx-layout-group"][content="app"])'
const AUTH = 'html:has(meta[name="stx-layout-group"][content="auth"])'

/*
 * analyticshq — Geist display + Geist Mono for numerics. One accent (emerald),
 * off-black/off-white, auto light+dark, radius lock 12px.
 *
 * `--accent` is a fill: behind `--accent-ink` it clears 4.5:1, but as small
 * text on the light page it is 3.6:1, so text in the accent colour uses
 * `--accent-text`. `--good` / `--bad` / `--warn` are the delta, error and
 * warning colours, which were Tailwind 500s written inline and read at 2-4:1
 * on the light palette. Each clears 4.5:1 on `--bg` and `--panel` in its own
 * theme. `color-scheme` makes the native controls (the site switcher, date
 * inputs, checkboxes, scrollbars) match the page instead of staying light on
 * the dark palette.
 *
 * The font stacks are custom properties, not `font-family` declarations, and
 * that is what makes them safe here.
 *
 * An earlier version of this comment said the single quotes were load-bearing:
 * that a double-quoted family in a preflight made the engine substitute its
 * own stack and swallow the rules after it. Both halves are wrong. Measured
 * against the installed engine, the trigger is the SPACED rule form --
 * `sel { prop: value; }` -- with a stack that begins with `ui-sans-serif`;
 * quoting makes no difference and no neighbouring rule is lost. A custom
 * property is never rewritten whatever its form, and `font-family: var(--sans)`
 * in CHROME below is not either, because the value is a var() reference.
 *
 * So the quoting is a style choice. It stays single because that is what the
 * views used, and because CSS treats the two identically.
 */
const APP_LIGHT = `color-scheme: light;
  --bg: #fbfbfc; --panel: #ffffff; --border: rgba(15,23,42,0.08);
  --text: #0b1220; --text-2: #4b5563; --text-3: #667085; --accent: #059669; --accent-ink: #04120d; --bar: rgba(5,150,105,0.16);
  --accent-text: #047857; --good: #047857; --bad: #c93434; --warn: #b45309;
  --sans: 'Geist', ui-sans-serif, system-ui, sans-serif;
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;`

const APP_DARK = `color-scheme: dark; --bg: #080b12; --panel: #0f131c; --border: rgba(148,163,184,0.12);
  --text: #f2f5f9; --text-2: #b0b9c8; --text-3: #7b879a; --accent: #34d399; --accent-ink: #04120d; --bar: rgba(52,211,153,0.18);
  --accent-text: #34d399; --good: #34d399; --bad: #f87171; --warn: #fbbf24;`

/*
 * The marketing palette under this layout's token names, so signing in looks
 * like the site you came from -- dark by default, light when the OS asks or
 * the reader picked it (config/ui.ts app.colorMode writes <html data-theme>
 * before first paint; the attribute beats the media query either way).
 *
 * The values are public/marketing.css's, spelled out rather than aliased: that
 * file is only linked by the marketing layout, so `var(--void)` would resolve
 * to nothing here. The duplication is marketing.css's 47 token declarations
 * being their own §11.2 debt, not this block's.
 */
const AUTH_DARK = `color-scheme: dark;
  --bg: #0a0c0e; --panel: #101317; --border: rgba(233,238,240,0.12);
  --text: #eef2f3; --text-2: #9aa4a9; --text-3: #7b878c;
  --accent: #46d3c0; --accent-ink: #04201c; --danger: #f87171;
  --sans: 'Geist', ui-sans-serif, system-ui, sans-serif; --mono: 'Geist Mono', ui-monospace, monospace;`

const AUTH_LIGHT = `color-scheme: light;
  --bg: #fafbfb; --panel: #ffffff; --border: rgba(12,18,20,0.12);
  --text: #0c1214; --text-2: #4e5a5f; --text-3: #5f6b72;
  --accent: #0f7c72; --accent-ink: #ffffff; --danger: #c93434;`

/*
 * One light set per group, written twice: the media query covers auto mode
 * (and a reader with scripts off), the attribute covers an explicit choice.
 * The explicit-choice rules come last and are (0,3,1), so a reader who picked
 * light on a dark-preferring OS gets light in both groups.
 */
const TOKENS = `${APP} { ${APP_LIGHT} }
@media (prefers-color-scheme: dark) { ${APP} { ${APP_DARK} } }
${APP}[data-theme="dark"] { ${APP_DARK} }
${APP}[data-theme="light"] { ${APP_LIGHT} }
${AUTH} { ${AUTH_DARK} }
@media (prefers-color-scheme: light) { ${AUTH}:not([data-theme="dark"]) { ${AUTH_LIGHT} } }
${AUTH}[data-theme="light"] { ${AUTH_LIGHT} }`

/*
 * The twelve rules both layouts carried identically.
 *
 * `body` is scoped to the two groups because `--bg` and `--text` are: on a
 * marketing page they are undefined, and `background: var(--bg)` with nothing
 * behind it is a declaration that computes to nothing. marketing.css's own
 * unlayered `body` rule would win there anyway, but relying on that would make
 * these pages depend on a file they do not link.
 *
 * `.wordmark` and the ThemeToggle rules are unscoped: no marketing page
 * carries either class -- marketing.css styles its nav toggle as
 * `.theme-toggle`, a different element -- so the name is the scope.
 *
 * ThemeToggle (resources/components/ThemeToggle.stx) shows the theme you would
 * switch TO: a sun on dark, a moon on light, keyed off the data-theme the
 * pre-paint boot writes. Those last two rules are why this is a preflight and
 * not a shortcut: `:root[data-theme="light"] .theme-toggle-btn .ic-moon` is a
 * descendant of an attribute on the root, which no utility spells.
 */
const CHROME = `${APP} body, ${AUTH} body { background: var(--bg); color: var(--text); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
.wordmark { font-weight: 700; letter-spacing: -0.03em; }
.theme-toggle-btn { display: inline-grid; place-items: center; width: 36px; height: 36px; padding: 0; flex-shrink: 0;
  border: 1px solid var(--border); border-radius: 10px; background: var(--panel); color: var(--text-2); cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease; }
.theme-toggle-btn:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.theme-toggle-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.theme-toggle-btn i { width: 1rem; height: 1rem; }
.theme-toggle-btn .ic-moon, :root[data-theme="light"] .theme-toggle-btn .ic-sun { display: none; }
:root[data-theme="light"] .theme-toggle-btn .ic-moon { display: block; }`

/*
 * The three rules from the app views that no utility can spell.
 *
 * `.panel` is here rather than in `shortcuts` for the reason the whole file
 * turns on: public/marketing.css declares `.panel` too, with its own surface,
 * radius and padding, and 10 marketing views carry the class. A shortcut would
 * be unlayered and served after that file, so it would repaint all ten; a
 * preflight is layered, loses to every property marketing.css sets, and
 * applies on the app pages where that file is not linked. Checked on the built
 * site: `.panel` on / is still #101317 at marketing.css's 18.4px padding.
 *
 * It was declared identically in dashboard.stx and visitor.stx -- the two
 * copies are gone, and BreakdownPanel.stx and invite.stx (which carry the
 * class but never had a rule for it, because invite.stx uses no layout) pick
 * it up for the first time.
 *
 * `.visit + .visit` is an adjacent sibling, which `peer-*` cannot express: it
 * emits a GENERAL sibling, so every later visit would take the margin instead
 * of each one after the first.
 *
 * The keyframes are named `skeleton-pulse`, not `pulse`. marketing.css already
 * has an unlayered `@keyframes pulse` driving its live dot, and @keyframes DO
 * obey layers -- an unlayered set beats a layered one of the same name -- so a
 * `pulse` here would be a silent, page-dependent swap of one animation for
 * another the first time anything loads both.
 */
const APP_VIEWS = `.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; }
.visit + .visit { margin-top: 12px; }
@keyframes skeleton-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 0.9; } }`

/*
 * /dashboard's own stylesheet: 178 rules, which was the last `<style>` block in
 * resources/ and more than half the app's hand-written CSS on its own.
 *
 * It stays raw CSS rather than becoming utilities, and that is a measurement
 * rather than a preference. Four things in here cannot be spelled as a class on
 * an element:
 *
 *   - ts-maps writes the `.ga-tip*` tooltips and the `#country-map` pin markup
 *     itself, from JavaScript, long after the extractor has read the page. No
 *     class the engine never sees can style a node that does not exist yet.
 *   - `::-webkit-details-marker`, `@supports not (background: color-mix(...))`
 *     and `.site-settings-shell:not([open]) ~ .site-settings-panel` have no
 *     utility form at all.
 *   - `@media (max-width: 1023px)` and `(max-width: 767px)` are exact. The
 *     engine's own are 1023.98px and 767.98px, and the arbitrary spelling
 *     `max-[1023px]:` generates NOTHING here -- in markup and inside a shortcut
 *     alike, checked rather than assumed. A preflight is the only vehicle that
 *     keeps the numbers.
 *   - `.drp-day.is-range`, `.range-tool.is-active` and the rest of the `.is-*`
 *     family land on elements the date picker renders in a loop, from its own
 *     signals.
 *
 * ## What moved while it moved
 *
 * Two declarations had to leave the call sites and come in here, because the
 * cascade direction reverses: a pushed <style> sits AFTER the generated sheet
 * and is unlayered, so it used to beat the utilities beside it, while a
 * preflight is layered and loses to all of them. Every one of the 178 rules was
 * checked against every call site carrying one of its class names, property by
 * property, and exactly two overlapped -- `.ga-row-label`'s hover colour
 * against `text-text-2`, and `.kpi-value`'s phone clamp against `text-3xl`.
 * Both are declared here with their base value now, where the more specific
 * rule in the same layer still wins. The other eight the check flagged were its
 * known over-approximation: it reads every class in a selector chain as the
 * subject, so `.filter-pill .fx { font-size: 12px }` looked like a clash with
 * `text-xs` on the `.filter-pill` itself.
 *
 * ## Why eleven rules are scoped and the other 167 are not
 *
 * This preflight is on every page, and public/marketing.css declares `.bar`,
 * `.reveal`, `.live-dot`, `.panel`, `.ic-sun` and `.ic-moon` too. Layering
 * protects the properties that file sets and nothing else: its `.bar` is a flex
 * track with no animation, so an unscoped `.bar { animation: grow }` would have
 * started animating the marketing bars, and `.live-dot::after` would have added
 * a second pulsing halo to a dot that already has one. Those rules carry the
 * app group's selector. The invariant -- any rule naming a class marketing.css
 * also declares must be scoped -- is a test, so the next shared name fails
 * rather than leaks.
 */
const DASHBOARD_CSS = `.pill { border-radius: 999px; transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease; }

.workspace-header {
  border-bottom: 1px solid var(--border);
}
.workspace-primary,
.workspace-range {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.workspace-primary { padding: 0 0 1.1rem; }
.workspace-range { padding: 0.85rem 0; }
.workspace-brand,
.workspace-actions,
.range-presets,
.range-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.workspace-brand { min-width: 0; gap: 0.9rem; }
.workspace-actions { flex-shrink: 0; }
.site-switcher {
  min-width: 11rem;
  max-width: 18rem;
  height: 2.25rem;
  padding: 0 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
}
.site-static {
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font: 500 0.875rem/1 var(--sans, ui-sans-serif);
}
.range-presets {
  gap: 0;
  padding: 0.2rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.range-link {
  min-width: 2.75rem;
  padding: 0.48rem 0.7rem;
  border-radius: 7px;
  color: var(--text-2);
  font: 600 0.8125rem/1 var(--sans, ui-sans-serif);
  text-align: center;
  text-decoration: none;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.range-link:hover { color: var(--text); }
/* "true", not "page": the range links all point at this same page, and the stx
   router's markCurrent() strips aria-current="page" from any link whose href is
   not the current pathname. A query-only href never is, so the active range lost
   its highlight on every load. "true" (the current item in a set) is also the
   accurate value for a picker, and the router leaves it alone. */
.range-link[aria-current="true"] {
  background: var(--accent);
  color: var(--accent-ink);
}
.range-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 2.25rem;
  padding: 0 0.72rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
  color: var(--text-2);
  font: 600 0.8125rem/1 var(--sans, ui-sans-serif);
  text-decoration: none;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
}
.range-tool:hover { color: var(--text); border-color: var(--accent); }
.range-tool:active { transform: scale(0.98); }
${APP} .range-tool:focus-visible, ${APP} .range-link:focus-visible, ${APP} .chrome-btn:focus-visible, ${APP} .icon-btn:focus-visible, ${APP} select.panel:focus-visible, ${APP} input:focus-visible, ${APP} textarea:focus-visible, ${APP} summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.range-tool.is-active { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.range-tool i { width: 1rem; height: 1rem; }
.date-menu { position: relative; }
.date-menu > summary { list-style: none; }
.date-menu > summary::-webkit-details-marker { display: none; }
.date-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 0.5rem);
  z-index: 40;
  width: min(44rem, calc(100vw - 2.5rem));
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 18px 50px color-mix(in srgb, var(--text) 10%, transparent);
}
/* Period picker: presets down the left, two months on the right. The range is
   drawn flat with rounded ends, the way Fathom's is, on the --bar wash the KPI
   bars already use so it reads as the same accent at the same strength. */
.drp-backdrop { position: fixed; inset: 0; z-index: 39; background: transparent; cursor: default; }
.drp { display: grid; grid-template-columns: 10.5rem minmax(0, 1fr); gap: 0.75rem; }
.drp-presets { display: flex; flex-direction: column; gap: 0.15rem; padding-right: 0.75rem; border-right: 1px solid var(--border); }
.drp-preset {
  display: block;
  width: 100%;
  padding: 0.5rem 0.7rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font: 500 0.8125rem/1.2 var(--sans, ui-sans-serif);
  text-align: left;
  cursor: pointer;
}
.drp-preset:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.drp-preset.is-active { color: var(--accent-ink); background: var(--accent); }
.drp-cals { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.drp-head { display: grid; grid-template-columns: 2rem minmax(0, 1fr) minmax(0, 1fr) 2rem; align-items: center; gap: 0.35rem; margin-bottom: 0.5rem; }
.drp-nav {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.drp-nav:hover { color: var(--text); border-color: var(--border); }
.drp-nav svg { width: 1rem; height: 1rem; }
.drp-nav.is-hidden { visibility: hidden; }
.drp-sel {
  min-width: 0;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 600 0.8125rem/1 var(--sans, ui-sans-serif);
}
.drp-dow, .drp-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.drp-dow span { padding: 0.25rem 0; color: var(--text-3); font: 600 0.7rem/1.2 var(--sans, ui-sans-serif); text-align: center; }
.drp-day {
  height: 2.25rem;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text);
  font: 500 0.8125rem/1 var(--mono, ui-monospace);
  cursor: pointer;
}
.drp-day:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.drp-day.is-out { color: var(--text-3); }
.drp-day.is-today { font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
.drp-day.is-range { background: var(--bar); }
.drp-day.is-edge { background: var(--accent); color: var(--accent-ink); border-radius: 8px; }
.drp-day.is-disabled { color: var(--text-3); opacity: 0.45; cursor: default; }
.drp-day.is-disabled:hover { background: transparent; }
.drp-day:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 8px; }
/* Live now strip. A quiet row under the header rather than a panel: it is read
   at a glance and should not compete with the numbers below it. */
.live-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 0.65rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
}
.live-head { display: inline-flex; align-items: center; gap: 0.5rem; color: var(--text-2); font-size: 0.8125rem; }
.live-head strong { color: var(--text); font-size: 0.9375rem; }
.live-dot-base { position: relative; display: inline-block; width: 8px; height: 8px; border-radius: 999px; }
.live-places { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.live-place {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-2);
  font-size: 0.8125rem;
  white-space: nowrap;
}
.live-place b { color: var(--text); font-weight: 600; font-size: 0.75rem; }
.live-flag { font-size: 0.9rem; line-height: 1; }
.live-muted { color: var(--text-3); font-size: 0.8125rem; }

/* Traffic chart. Gridlines and labels are HTML laid over the SVG at the same
   percentages the SVG scale uses, so text stays crisp under preserveAspectRatio="none". */
.chart-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 0.75rem; margin-bottom: 1.1rem; }
.chart-sum { margin-top: 0.35rem; color: var(--text-2); font-size: 0.875rem; }
.chart-sum b { color: var(--text); font-size: 1.05rem; font-weight: 600; }
.chart-dot { margin: 0 0.35rem; color: var(--text-3); }
.ga-grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--border); pointer-events: none; }
.ga-ylab { position: absolute; left: 0; bottom: 2px; padding-right: 4px; background: var(--panel); color: var(--text-3); font-size: 0.6875rem; line-height: 1; }
.ga-xlab { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.ga-x-start { transform: none; }
.ga-x-end { transform: translateX(-100%); }

/* Account menu. Positioned like the date picker's popover; .drp-backdrop (shared)
   covers the page while it is open so a click elsewhere closes it. */
.account-menu { position: relative; }
.account-menu > summary { list-style: none; }
.account-menu > summary::-webkit-details-marker { display: none; }
.account-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.45rem 0.25rem 0.25rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text-2);
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.account-trigger:hover,
.account-menu[open] > .account-trigger { border-color: var(--accent); }
.account-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.account-avatar {
  display: inline-grid;
  place-items: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  font: 600 0.8125rem/1 var(--sans, ui-sans-serif);
}
.account-chevron { width: 0.9rem; height: 0.9rem; transition: transform 0.15s ease; }
.account-menu[open] .account-chevron { transform: rotate(180deg); }
.account-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 0.5rem);
  z-index: 40;
  width: 15rem;
  padding: 0.4rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.25);
}
.account-who { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.55rem 0.65rem 0.65rem; border-bottom: 1px solid var(--border); margin-bottom: 0.3rem; min-width: 0; }
.account-who strong { color: var(--text); font-size: 0.8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-who span { color: var(--text-3); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.55rem 0.65rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font: 500 0.8125rem/1.2 var(--sans, ui-sans-serif);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.account-item:hover,
.account-item:focus-visible { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--text); outline: none; }
.account-item i { width: 1rem; height: 1rem; color: var(--text-3); }
.account-sep { height: 1px; margin: 0.3rem 0.2rem; background: var(--border); }
.theme-btn .lbl-light, .theme-btn .lbl-dark { display: none; }
.theme-btn[data-t="light"] .lbl-light { display: inline; }
.theme-btn[data-t="dark"] .lbl-dark { display: inline; }
.range-icon { padding-left: 0; padding-right: 0; min-width: 2.25rem; justify-content: center; }
/* Arrives from the account menu's #site-settings link with room above it. */
#site-settings { scroll-margin-top: 1.25rem; }
.site-settings-shell > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  width: 100%;
  padding: 0.9rem 1rem;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  list-style: none;
}
.site-settings-shell > summary::-webkit-details-marker { display: none; }
.site-settings-title { display: flex; align-items: center; gap: 0.7rem; min-width: 0; }
.site-settings-title i { width: 1.1rem; height: 1.1rem; color: var(--text-2); }
.site-settings-title strong { display: block; font-size: 0.875rem; line-height: 1.25; }
.site-settings-title span { display: block; margin-top: 0.18rem; color: var(--text-3); font-size: 0.75rem; line-height: 1.35; }
.settings-chevron { width: 1rem; height: 1rem; flex-shrink: 0; color: var(--text-3); transition: transform 0.15s ease; }
.site-settings-shell[open] .settings-chevron { transform: rotate(180deg); }
.site-settings-shell:not([open]) ~ .site-settings-panel { display: none; }
.site-settings-panel { margin-bottom: 0.75rem; }

@media (max-width: 1023px) {
  .workspace-primary,
  .workspace-range { align-items: stretch; flex-direction: column; }
  .workspace-brand,
  .workspace-actions,
  .range-actions { width: 100%; flex-wrap: wrap; }
  .workspace-actions { justify-content: flex-start; }
  .site-switcher { min-width: 0; max-width: none; flex: 1; }
  .range-presets { width: 100%; overflow-x: auto; }
  .range-link { flex: 1 0 auto; }
  .range-actions { justify-content: flex-start; }
  .date-menu { position: static; }
  .date-popover { left: 0; right: auto; width: calc(100vw - 2rem); max-height: calc(100dvh - 6rem); overflow-y: auto; overscroll-behavior: contain; }
  .drp { grid-template-columns: minmax(0, 1fr); }
  .drp-presets { flex-direction: row; flex-wrap: wrap; gap: 0.35rem; padding: 0 0 0.6rem; border-right: 0; border-bottom: 1px solid var(--border); }
  .drp-preset { width: auto; padding: 0.45rem 0.65rem; border: 1px solid var(--border); border-radius: 999px; }
  .drp-cals { grid-template-columns: minmax(0, 1fr); }
  .drp-cal.is-right { display: none; }
  .drp-cal.is-left .drp-nav.is-hidden { visibility: visible; }
  .drp-day { height: 2.5rem; }
}

/* Site switcher. Surface, border and radius come from .panel. The native menu remains
  an operating-system control, while the surrounding shell gives it enough room to
  avoid colliding with adjacent actions. */
${APP} select.panel {
  cursor: pointer;
  transition: border-color 0.15s ease;
}
${APP} select.panel:hover { border-color: var(--accent); }

/* Map tooltips, themed. ts-maps binds and positions these itself, but only its
  own stylesheet makes them work, and it is linked above rather than restated
  here -- a subset is not enough. Two separate things break without it, and only
  one is visible. Every .tsmap-pane defaults to position:static, so the tooltip
  rendered in normal flow under the map, full width and transparent: bound,
  built, unstyled. Less obvious, the pane holding the country polygons is an
  <svg pointer-events="none">, and it is the vendor rule re-enabling
  \`path.tsmap-interactive\` that lets a pointer reach a country at all -- without
  it nothing on the map is hoverable OR clickable, so the click-to-filter below
  never fired either.
  Loading the whole file is safe: all 88 of its top-level rules are keyed on a
  .tsmap- class, and those exist only inside #country-map.
  What is overridden here is presentation only. The vendor tooltip is a white
  box with #222 text and a white arrow, which is unreadable on this palette;
  these rules restate it in the same chrome as .ga-tip below, so the map and the
  traffic chart answer a hover the same way. */
/* The sea. ts-maps paints its container with --tsmap-tile-bg, a light grey
  matched to a light basemap, so in dark mode the map sat in a pale grey slab.
  (Before 0.3.15 it also removed the inline background:var(--bg) the markup
  sets on the first zoom.) Pointing the engine's own token at ours fixes both
  themes, and a theme flip needs no script because it is plain CSS. */
#country-map.tsmap-container { --tsmap-tile-bg: var(--bg); background: var(--bg); }
/* Land with no visits, and the base every visited country's fill is mixed from
  (styleFor in the map script). A step off the sea toward the text colour, so
  it reads as land on either palette. */
#country-map { --map-land: color-mix(in srgb, var(--text) 8%, var(--bg)); }

#country-map .tsmap-tooltip {
  padding: 6px 9px; border-radius: 8px;
  background: var(--panel); border: 1px solid var(--border); color: var(--text-2);
  font-size: 12px; line-height: 1.4;
  box-shadow: 0 8px 24px rgba(0,0,0,0.28);
}
/* The arrow is drawn as a border triangle, so its colour is set per direction
  and each one has to be re-pointed at the panel token separately. */
#country-map .tsmap-tooltip-top:before { border-top-color: var(--panel); }
#country-map .tsmap-tooltip-bottom:before { border-bottom-color: var(--panel); }
#country-map .tsmap-tooltip-left:before { border-left-color: var(--panel); }
#country-map .tsmap-tooltip-right:before { border-right-color: var(--panel); }

${APP} .bar { animation: grow 0.6s cubic-bezier(0.16,1,0.3,1); transform-origin: bottom; }
@keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
${APP} .reveal { opacity: 0; transform: translateY(10px); animation: reveal 0.5s cubic-bezier(0.16,1,0.3,1) forwards; }
@keyframes reveal { to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { ${APP} .bar, ${APP} .reveal { animation: none; opacity: 1; transform: none; } }

/* Live "current visitors" badge: expanding halo ring behind the dot (only when > 0). */
${APP} .live-dot::after { content: ''; position: absolute; inset: 0; border-radius: 999px; background: var(--accent); animation: livepulse 2s cubic-bezier(0.16,1,0.3,1) infinite; }
@keyframes livepulse { 0% { transform: scale(1); opacity: 0.55; } 100% { transform: scale(2.8); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { ${APP} .live-dot::after { animation: none; opacity: 0; } }

/* Live visitors on the map: one dot per country with someone online, the same
   halo as the badge above. Sized by the map script, centred by DivIcon's anchor. */
#country-map .live-pin { position: absolute; pointer-events: auto; }
#country-map .live-pin i { position: absolute; inset: 0; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 2px var(--panel); }
#country-map .live-pin i::after { content: ''; position: absolute; inset: 0; border-radius: 999px; background: var(--accent); animation: livepulse 2s cubic-bezier(0.16,1,0.3,1) infinite; }
@media (prefers-reduced-motion: reduce) { #country-map .live-pin i::after { animation: none; opacity: 0; } }

/* Timeseries area+line chart: CSS-only hover tooltips + markers. Columns are transparent
  full-height hover targets; dots align to the SVG line via the same (i+0.5)/n center fraction. */
.ga-col:hover::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--border); pointer-events: none; }
.ga-dot { position: absolute; left: 50%; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 999px; box-shadow: 0 0 0 3px var(--panel); opacity: 0; transition: opacity 0.12s ease; pointer-events: none; }
.ga-dot-v { background: var(--accent); }
.ga-dot-u { background: var(--text-3); }
.ga-col:hover .ga-dot { opacity: 1; }
.ga-tip { display: none; position: absolute; left: 50%; transform: translateX(-50%) translateY(calc(-100% - 12px)); min-width: 124px; padding: 8px 10px; border-radius: 9px; background: var(--panel); border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,0.14); pointer-events: none; z-index: 20; }
.ga-col:hover .ga-tip { display: block; }
.ga-tip-day { font-size: 11px; color: var(--text-2); margin-bottom: 5px; }
.ga-tip-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); white-space: nowrap; line-height: 1.7; }
.ga-tip-row b { margin-left: auto; color: var(--text); font-weight: 600; }
.ga-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
@media (max-width: 1023px) {
  .ga-col:hover::before,
  .ga-dot,
  .ga-tip { display: none; }
}

/* Export CSV pill: hover tightens the border to the accent like the range pills. */
#export-csv:hover { color: var(--text); border-color: var(--accent); }

/* Clickable breakdown rows: whole row is a link that adds a filter. Keep the row
  chrome identical; a subtle wash + cursor on hover is the only affordance. The bar
  div uses inset-y-1, so the anchor keeps position: relative as its offset parent. */
.ga-row { display: flex; text-decoration: none; color: inherit; border-radius: 6px; cursor: pointer; transition: background-color 0.12s ease; }
.ga-row:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
@supports not (background: color-mix(in srgb, red, blue)) { .ga-row:hover { background: var(--bar); } }
/* The label's base colour is here, not \`text-text-2\` on the element, because
  the hover rule below has to beat it. Both live in the generated sheet's layer
  now, where the descendant selector outranks this one; an unlayered utility on
  the element would have outranked BOTH and the row would have stopped
  brightening on hover. 11 call sites dropped the utility. */
.ga-row-label { color: var(--text-2); }
.ga-row:hover .ga-row-label { color: var(--text); }

/* Filter-pill bar: active segment filters, each removable; matches the range pills. */
.filter-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 11px; border: 1px solid var(--border); background: var(--panel); color: var(--text-2); text-decoration: none; }
.filter-pill:hover { border-color: var(--accent); color: var(--text); }
.filter-pill .fx { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 999px; font-size: 12px; line-height: 1; color: var(--text-3); }
.filter-pill:hover .fx { color: var(--accent); }
.filter-clear { color: var(--text-3); text-decoration: none; }
.filter-clear:hover { color: var(--text); }

/* Account chrome. Plain CSS rather than utility classes: these controls sat on
   ~700 characters of inline style each, which is why the Upgrade control ended up
   with a client-reactive :style and became the one link on the page that could not
   use the SPA router. Every token here is themed, so the chrome follows light/dark
   with the rest of the app instead of pinning its own colours.

   One variant, not three. .chrome-cta and .chrome-pro existed for the Upgrade/Pro
   button that now lives on /account, and were deleted with it rather than left
   behind — an unused accent style is how the next person ends up reintroducing the
   duplication this removed. */
.chrome-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px; border-radius: 9px; border: 1px solid var(--border); background: var(--panel); color: var(--text-2); font: 500 13px/1 var(--sans, ui-sans-serif); text-decoration: none; cursor: pointer; transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease; }
.chrome-btn:hover { color: var(--text); border-color: var(--accent); }
.chrome-icon { padding: 7px 10px; font-size: 14px; line-height: 1; }

/* The desktop size, which was \`text-3xl\` on the element. It had to come here:
  an unlayered utility beats the clamp in the phone media query below, so the
  number would have stayed at 30px and overflowed its card on a narrow screen.
  Same declarations text-3xl emits. */
.kpi-value { font-size: 1.875rem; line-height: 2.25rem; }

@media (max-width: 767px) {
  .site-switcher,
  .range-tool,
  .account-trigger,
  .account-item,
  .chrome-btn,
  .range-link,
  .ga-row,
  .goal-form input,
  .goal-form select,
  .goal-form button { min-height: 2.75rem; }

  .site-switcher { height: 2.75rem; }
  .range-link { display: inline-flex; align-items: center; justify-content: center; }
  .range-tool { min-width: 2.75rem; }
  /* Wordmark and account button share the first row; the site switcher takes
     the full width under them, instead of the button wrapping onto a row alone. */
  .workspace-primary { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
  .workspace-brand { display: contents; }
  .workspace-brand .wordmark { flex: 1 1 auto; }
  .workspace-actions { order: 2; width: auto; }
  .site-switcher, .site-static { order: 3; flex: 1 1 100%; }
  .ga-row { align-items: center; }
  .kpi-label { min-height: 2rem; }
  .kpi-value { font-size: clamp(1.375rem, 7.25vw, 1.875rem); line-height: 1.2; white-space: nowrap; }
}
/* One glyph at a time. \`theme.isDark()\` writes data-t, and these pick the matching
  icon -- the same contract bughq's header uses, so the two toggles behave alike. */
${APP} .theme-btn .ic-sun, ${APP} .theme-btn .ic-moon { display: none; }
${APP} .theme-btn[data-t="light"] .ic-moon { display: block; }
${APP} .theme-btn[data-t="dark"] .ic-sun { display: block; }`

export default {

  content: [
    './resources/views/**/*.{stx,html}',
    './resources/**/*.{stx,html}',
    // Two globs pointing into storage/framework/defaults were here, scanning 346
    // templates. They are gone because they were worse than the zero-match glob
    // described below, not merely as bad.
    //
    // storage/framework/ is gitignored build output left over from before this app
    // adopted framework-as-dependencies. Its copy of defaults/ has since diverged
    // from the published @stacksjs/defaults — a class sorter has been run over it at
    // some point and reordered the tokens INSIDE template expressions, so
    // Marketing/Feature.stx reads
    //   class="hover:opacity-100' : !isActive ? '' 'opacity-75 {{ {{ }} }} className"
    // where the package still has the intact ternary. Scanning that harvests
    // fragments like `'text-red-700` and `hover:opacity-100'` as class candidates.
    //
    // It bought nothing either way: no view in this app renders a defaults component,
    // so none of their classes can reach the output. Measured before removing —
    // the generated CSS contained none of opacity-75, text-red-700, bg-blue-900 or
    // i-hugeicons, and removing the globs left every page's stylesheet byte-identical.
    //
    // storage/framework/core/error-handling/src/views was also here and matched nothing.
    // Adopting framework-as-dependencies removed storage/framework/core entirely, and
    // the error views did not reappear under node_modules/@stacksjs/error-handling —
    // there is no path to repoint this at. A glob that silently matches zero files is
    // worse than no glob: it reads as coverage. If error views ever ship utility
    // classes again, add the real path back rather than restoring this one.
  ],
  preflight: true,
  minify: false,

  /*
   * The two layouts' former `<style>` blocks. One entry, not several: the
   * engine passes a preflight's string through verbatim, so a multi-rule
   * entry keeps its rules and their order (checked against the installed
   * engine -- an earlier splitter in loghq was guarding a loss that does not
   * happen on ts-css).
   */
  /*
   * One entry per section, in cascade order, rather than one entry holding all
   * four. The engine concatenates them in order and passes each through
   * verbatim, so the result is byte-identical -- but a test can address a
   * section on its own, and the leak invariant on DASHBOARD_CSS below is
   * stricter than the one the chrome above can satisfy.
   */
  preflights: [
    { getCSS: () => TOKENS },
    { getCSS: () => CHROME },
    { getCSS: () => APP_VIEWS },
    { getCSS: () => DASHBOARD_CSS },
  ],
  // The theme below maps utility names onto the tokens the preflight declares,
  // so `text-text-2`, `bg-panel`, `border-border` exist and replace the
  // repetitive inline `style="color: var(--text-2)"` these views used to carry.
  /**
   * Shared chrome, defined once here rather than per page.
   *
   * A `<style>` block in a view is invisible to the Crosswind extractor, which
   * only reads `class=` attributes, and the SPA router keeps only the generated
   * Crosswind tag across a fragment swap. A shortcut is the supported home for a
   * repeated composite, and it is where bughq keeps the same button.
   */
  shortcuts: {
    /*
     * ## The auth controls
     *
     * The five auth views' form chrome, which lived in resources/layouts/auth.stx.
     * Shortcuts rather than preflight rules because every one of these shapes is
     * something the engine can spell, and because a shortcut is unlayered: it
     * composes with the utilities already at the call sites (`py-2.5 w-full
     * font-semibold text-sm`) the same way the old `<style>` rules did -- none of
     * those nine sites sets a radius, a background or a border, so there is
     * nothing for either side to fight over.
     *
     * `btn-accent`, not `btn`. `.btn` belongs to public/marketing.css, which 20
     * marketing views and 4 components use and which declares background, color,
     * border, border-radius and transition on it. A shortcut called `btn` would be
     * unlayered and served after that file, so it would have repainted every
     * marketing button; a preflight called `btn` would have lost to it on those
     * pages and still collided with account.stx's and visitor.stx's own `.btn`.
     * A name marketing.css has no claim on cannot be caught either way -- the same
     * reasoning `empty-row` below is named for.
     *
     * The radius is `rounded-control`, the 10px role in theme.extend.borderRadius,
     * rather than a repeated `rounded-[10px]`: all four of these controls were
     * 10px by hand.
     */
    'btn-accent': 'bg-accent text-accent-ink rounded-control font-semibold '
      + '[transition:transform_0.12s_ease,opacity_0.15s_ease,background-color_0.15s_ease] '
      + 'hover:bg-[color-mix(in_srgb,var(--accent)_88%,#000)] '
      + 'active:[transform:translateY(1px)] disabled:opacity-60 disabled:cursor-default',

    // Bordered on the panel colour: the Google/GitHub buttons under the divider.
    'oauth-btn': 'border border-solid border-border rounded-control text-text bg-panel '
      + '[transition:border-color_0.15s_ease,transform_0.12s_ease] '
      + 'hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] '
      + 'active:[transform:translateY(1px)]',

    // Eleven inputs across the five auth views. `focus:outline-none` emits
    // `outline-style: none`, which is what `outline: none` did here.
    'field': 'bg-bg border border-solid border-border rounded-control text-text '
      + 'focus:outline-none focus:border-accent '
      + 'focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--accent)_16%,transparent)]',

    /*
     * The tint and text colour of an inline form notice; `notice-box` below is
     * the geometry the two share. Spelled with the literal `var(--danger)`
     * rather than `text-danger`, which resolves to `var(--bad, var(--danger))`:
     * these eight sites are all on the auth layout, whose palette defines
     * `--danger` and not `--bad`, so the alias would work only by falling back.
     */
    'err': 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]',
    'ok': 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent',

    // "or" between the password form and the OAuth buttons, with a rule either
    // side. `flex-1` emits `flex: 1 1 0%`, the longhand of the `flex: 1` this
    // replaces.
    'divider': 'flex items-center gap-3 text-text-3 text-[12px] '
      + "before:content-[''] before:h-px before:flex-1 before:bg-border "
      + "after:content-[''] after:h-px after:flex-1 after:bg-border",

    /*
     * ## account.stx and visitor.stx
     *
     * Two `<style>` blocks that between them declared `.btn` three different
     * ways -- account's base-plus-modifier pair and visitor's bordered one --
     * on top of the auth layout's filled one and public/marketing.css's. The
     * four were never four buttons. Measured declaration by declaration,
     * account's `.btn.btn-primary` IS the auth layout's button, and account's
     * `.btn.btn-ghost` IS visitor's `.btn`, down to the colour stops in the
     * hover `color-mix`. What differed was the transition list, and only
     * because each copy listed the properties its own page happened to
     * animate. So: two buttons, both supersets.
     *
     * `btn-accent` picked up `font-semibold` and `background-color` in its
     * transition from account's copy. The nine auth call sites already wrote
     * `font-semibold` themselves, so the weight is unchanged there; the
     * transition means the sign-in button's hover now eases instead of
     * snapping, which is what account's button always did.
     *
     * `btn-danger` is a WHOLE button, not a modifier to add beside
     * `btn-ghost`. As a modifier it would have had to beat `btn-ghost:hover`
     * at the same specificity, which works only while the two names stay in
     * that order in the class attribute -- and pickier's sort-tailwind-classes
     * rule is entitled to reorder them, at which point the destructive button
     * silently loses its red. Six repeated utilities is the cheaper half of
     * that trade.
     */
    'btn-ghost': 'border border-solid border-border rounded-control text-text font-semibold '
      + '[transition:border-color_0.15s_ease,transform_0.12s_ease,opacity_0.15s_ease,background-color_0.15s_ease] '
      + 'hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] '
      + 'active:[transform:translateY(1px)]',
    'btn-danger': 'border border-solid border-border rounded-control text-text font-semibold '
      + '[transition:border-color_0.15s_ease,transform_0.12s_ease,opacity_0.15s_ease,background-color_0.15s_ease] '
      + 'hover:border-[var(--bad)] hover:text-[var(--bad)] '
      + 'active:[transform:translateY(1px)]',

    // account.stx's surfaces. `card` is `panel` at a 14px radius; it keeps its
    // own name because it is a different radius, not because it is a different
    // idea, and because marketing.css has no claim on `card`.
    'card': 'bg-panel border border-solid border-border rounded-[14px]',
    'badge': 'border border-solid border-border rounded-pill [font-family:var(--mono)] '
      + 'text-[11px] tracking-[0.04em] uppercase text-text-2',
    // The one place `--accent-text` is read directly: the pro badge is small
    // accent text, which is the 3.6:1 case `--accent` is not allowed for.
    'badge-pro': 'border-accent text-[var(--accent-text)]',
    'avatar': 'rounded-pill object-cover bg-[color-mix(in_srgb,var(--accent)_14%,var(--panel))]',
    // `row-rule`, not `row`: a shortcut is global and unlayered, and `row` is
    // the kind of name a future template reaches for without meaning this.
    'row-rule': 'border-t border-solid border-border',
    'skeleton': 'bg-[color-mix(in_srgb,var(--text-3)_20%,transparent)] rounded-[6px] '
      + 'animate-[skeleton-pulse_1.4s_ease-in-out_infinite] motion-reduce:animate-none',

    /*
     * visitor.stx's timeline, plus the `mono` both it and the dashboard
     * declared identically. `mono` keeps its name -- marketing.css has no
     * `.mono` rule -- so none of its 8 call sites changes.
     *
     * `[font-family:var(--mono)]` rather than `font-mono`, which resolves to
     * the engine's own `ui-monospace, monospace` and would drop Geist Mono.
     *
     * `stat-key` is visitor's `.stat-label` renamed. marketing.css declares
     * `.stat-label` with a margin, a colour and a size, and 2 marketing views
     * use it; this one adds `font-family`, `letter-spacing` and
     * `text-transform`, which that file does NOT set -- so either vehicle
     * under the old name would have leaked uppercase mono onto those pages.
     * A preflight loses only where the other file declares the same property.
     */
    'mono': "[font-family:var(--mono)] [font-feature-settings:'tnum'_1]",
    'stat-key': '[font-family:var(--mono)] text-[11px] tracking-[0.04em] uppercase text-text-3',
    'step-rail': 'border-l border-solid border-border',
    'step-row': "relative before:content-[''] before:absolute before:left-[-20px] before:top-[11px] "
      + 'before:w-[7px] before:h-[7px] before:rounded-pill before:bg-border '
      + 'data-[kind=conversion]:before:bg-accent data-[kind=event]:before:bg-text-3',

    /*
     * Sized to sit level with the pill controls beside it: those are px-3 py-1.5
     * on a 13px line, which lands at 34px, so this is a 34px square rather than
     * a padded box that would drift when the row wraps.
     */
    'icon-btn': 'inline-flex items-center justify-center w-[34px] h-[34px] '
      + 'border border-solid border-border rounded-[9px] text-text-2 bg-panel cursor-pointer '
      + '[transition:color_0.15s_ease,border-color_0.15s_ease] '
      + 'hover:text-text hover:border-accent '
      + '[&_svg]:w-[17px] [&_svg]:h-[17px]',

    /*
     * The placeholder a panel shows when its list came back empty: the
     * `@empty` branch of a forelse, or the `@else` of the block that would
     * otherwise have drawn the map. Thirteen sites carried
     * `py-8 text-center text-sm text-text-3` as four separate utilities,
     * byte-identical in every one, twelve of them in dashboard.stx.
     *
     * Expands to exactly those four and nothing else, so the generated rule
     * carries the same four declarations the call sites already got. No `!`
     * anywhere: this REPLACES the utilities rather than overriding a
     * component's, so there is nothing of equal specificity to beat.
     *
     * Named outside the `panel-*` family on purpose, even though every one of
     * these sits inside a `.panel`. `panel-head` and `panel-tag` belong to
     * public/marketing.css, and a shortcut sharing one of those names would
     * not lose to that file -- it would WIN, which is worse. Both are
     * unlayered, and the generated sheet is linked after /marketing.css, so
     * the later rule takes it (corrected here: this comment used to claim the
     * shortcut lost, and the rendered order says otherwise). A name that file
     * has no claim on cannot be caught either way.
     */
    'empty-row': 'py-8 text-center text-sm text-text-3',

    /*
     * The box an inline form notice sits in: the error banner above a form and
     * the confirmation that replaces it. Nine sites across the five auth-shaped
     * views spelled `px-3 text-sm rounded-lg` out in full, identically.
     *
     * The COLOUR is not in here. `.err` and `.ok` live in the auth layout's own
     * style block and already carry the tint and the text colour, so this is
     * the geometry only and the two compose: `class="mb-4 py-2 notice-box err"`.
     *
     * The vertical padding is not in here either, and that is deliberate rather
     * than an oversight. Errors sit at py-2 and confirmations at py-3 across
     * this app, bughq and loghq alike, so it is a real axis at the call site;
     * folding in the more common one would mean `!py-3` on a third of the
     * sites, which is worse than leaving one utility visible.
     */
    'notice-box': 'px-3 text-sm rounded-lg',
  },

  theme: {
    extend: {
      borderRadius: {
        control: '10px',
        pill: '999px',
        /*
         * `rounded-panel` is @stacksjs/components' radius role name:
         * <EmptyState variant="panel"> renders `bg-panel rounded-panel
         * ring-1 ring-line`. Without this it resolves to nothing and the
         * panel renders square. 12px is this app's own `.panel` radius,
         * the one dashboard.stx and visitor.stx both declare.
         */
        panel: '12px',
      },
      colors: {
        'bg': 'var(--bg)',
        'panel': 'var(--panel, var(--surface))',
        'border': 'var(--border)',
        'text': 'var(--text)',
        'text-2': 'var(--text-2)',
        'text-3': 'var(--text-3)',
        'accent': 'var(--accent)',
        'bar': 'var(--bar)',

        // Map the complete component vocabulary onto this app's palettes.
        // Use theme entries, not layered preflight --stx-* declarations: the
        // library emits unlayered role defaults that win over a preflight.
        // Keep the existing theme bootstrap unchanged; these aliases follow
        // the palette variables rather than the library's stock light/dark hues.
        // Marketing names its tokens surface/ink/void, whereas app/auth use
        // panel/text/bg. Fallbacks cover both without importing marketing CSS.
        'surface': 'var(--panel, var(--surface))',
        'surface-sunken': 'var(--bg, var(--void))',
        'surface-raised': 'color-mix(in srgb, var(--accent) 8%, var(--panel, var(--surface)))',
        'surface-hover': 'color-mix(in srgb, var(--text, var(--ink)) 6%, var(--panel, var(--surface)))',
        'surface-raised-hover': 'color-mix(in srgb, var(--accent) 14%, var(--panel, var(--surface)))',
        'surface-sunken-hover': 'color-mix(in srgb, var(--text, var(--ink)) 6%, var(--bg, var(--void)))',
        'page': 'var(--bg, var(--void))',
        'content': 'var(--panel, var(--surface))',
        'field': 'var(--panel, var(--surface))',
        'field-hover': 'color-mix(in srgb, var(--text, var(--ink)) 6%, var(--panel, var(--surface)))',
        'fg': 'var(--text, var(--ink))',
        'fg-strong': 'var(--text, var(--ink))',
        'fg-muted': 'var(--text-2, var(--muted))',
        /*
         * The library's quiet text scale is four steps - fg, fg-muted, fg-soft,
         * fg-subtle - and this palette has three, so two roles share a value.
         * They used to share at the WRONG end: fg-soft was byte-identical to
         * fg-muted, which makes "quieter than muted" exactly as loud as muted.
         *
         * Nothing renders it today, which is why it was invisible: of the 53
         * <EmptyState> sites in the estate none passes an `icon` (the only
         * thing there that reads fg-soft) and there is no <Badge dot>. But
         * <Breadcrumb> paints separators with fg-soft and links with fg-muted,
         * so the two being equal is a divider as loud as the labels it divides.
         *
         * Doubling up at the quiet end keeps the scale monotonic, so a
         * component asking for a quieter grey gets one.
         */
        'fg-soft': 'var(--text-3, var(--faint))',
        'fg-subtle': 'var(--text-3, var(--faint))',
        'line': 'var(--border, var(--line))',
        'line-strong': 'color-mix(in srgb, var(--text-3, var(--faint)) 55%, var(--border, var(--line)))',
        'line-hover': 'color-mix(in srgb, var(--text-2, var(--muted)) 70%, var(--border, var(--line)))',
        // The dashboard distinguishes small accent text from its brighter fill.
        'link': 'var(--accent-text, var(--accent))',
        'link-hover': 'color-mix(in srgb, var(--accent-text, var(--accent)) 85%, var(--text, var(--ink)))',
        'accent-solid': 'var(--accent)',
        // A stronger darkening drops the light dashboard's dark label below AA.
        'accent-solid-hover': 'color-mix(in srgb, var(--accent) 95%, var(--text, var(--ink)))',
        'accent-ink': 'var(--accent-ink)',
        'accent-soft': 'color-mix(in srgb, var(--accent) 8%, var(--panel, var(--surface)))',
        'accent-soft-ink': 'var(--accent-text, var(--accent))',

        'success': 'var(--good, var(--accent))',
        'success-solid': 'var(--good, var(--accent))',
        'success-solid-hover': 'color-mix(in srgb, var(--good, var(--accent)) 92%, var(--text, var(--ink)))',
        'success-ink': 'var(--panel, var(--surface))',
        'success-soft': 'color-mix(in srgb, var(--good, var(--accent)) 8%, var(--panel, var(--surface)))',
        'success-soft-ink': 'color-mix(in srgb, var(--good, var(--accent)) 85%, var(--text, var(--ink)))',
        'danger': 'var(--bad, var(--danger))',
        'danger-solid': 'var(--bad, var(--danger))',
        'danger-solid-hover': 'color-mix(in srgb, var(--bad, var(--danger)) 92%, var(--text, var(--ink)))',
        'danger-ink': 'var(--panel, var(--surface))',
        'danger-soft': 'color-mix(in srgb, var(--bad, var(--danger)) 8%, var(--panel, var(--surface)))',
        'danger-soft-ink': 'color-mix(in srgb, var(--bad, var(--danger)) 85%, var(--text, var(--ink)))',
        'danger-fg': 'var(--bad, var(--danger))',
        'danger-fg-subtle': 'var(--bad, var(--danger))',
        'danger-line': 'var(--bad, var(--danger))',
        'danger-focus': 'var(--bad, var(--danger))',
        // Only the dashboard has amber. Auth/marketing use a deliberate neutral
        // warning; info/secondary are neutral everywhere, not stock cyan/purple.
        'warning': 'var(--warn, var(--text-2, var(--muted)))',
        'warning-solid': 'var(--warn, var(--text-2, var(--muted)))',
        'warning-solid-hover': 'color-mix(in srgb, var(--warn, var(--text-2, var(--muted))) 92%, var(--text, var(--ink)))',
        'warning-ink': 'var(--panel, var(--surface))',
        'warning-soft': 'color-mix(in srgb, var(--warn, var(--text-2, var(--muted))) 8%, var(--panel, var(--surface)))',
        'warning-soft-ink': 'color-mix(in srgb, var(--warn, var(--text-2, var(--muted))) 85%, var(--text, var(--ink)))',
        'info': 'var(--text-2, var(--muted))',
        'info-solid': 'var(--text-2, var(--muted))',
        'info-solid-hover': 'var(--text, var(--ink))',
        'info-ink': 'var(--panel, var(--surface))',
        'info-soft': 'color-mix(in srgb, var(--text, var(--ink)) 8%, var(--panel, var(--surface)))',
        'info-soft-ink': 'var(--text-2, var(--muted))',
        'secondary': 'var(--text-2, var(--muted))',
        'secondary-solid': 'var(--text-2, var(--muted))',
        'secondary-solid-hover': 'var(--text, var(--ink))',
        'secondary-ink': 'var(--panel, var(--surface))',
        'secondary-soft': 'color-mix(in srgb, var(--text, var(--ink)) 8%, var(--panel, var(--surface)))',
        'secondary-soft-ink': 'var(--text-2, var(--muted))',
        'inverse': 'var(--text, var(--ink))',
        'inverse-ink': 'var(--bg, var(--void))',
      },
    },
  },
}
