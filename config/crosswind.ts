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
 * Single quotes around the font families, not double. A double-quoted family
 * in a preflight makes this engine substitute its own default stack and
 * swallow the rules that follow -- measured on ts-css, and the reason the same
 * block in commshq is single-quoted too.
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
  preflights: [{ getCSS: () => `${TOKENS}\n${CHROME}\n${APP_VIEWS}` }],
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
