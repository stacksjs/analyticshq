/**
 * Crosswind (utility CSS) — content globs for STX views.
 * @see https://github.com/cwcss/crosswind
 */
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
  // Register the design tokens (defined as CSS vars in each view's :root, so they
  // stay theme-reactive for light/dark) so utilities like `text-text-2`,
  // `bg-panel`, `border-border` exist — replacing repetitive inline
  // `style="color: var(--text-2)"` etc. with crosswind classes.
  /**
   * Shared chrome, defined once here rather than per page.
   *
   * A `<style>` block in a view is invisible to the Crosswind extractor, which
   * only reads `class=` attributes, and the SPA router keeps only the generated
   * Crosswind tag across a fragment swap. A shortcut is the supported home for a
   * repeated composite, and it is where bughq keeps the same button.
   *
   * Sized to sit level with the pill controls beside it: those are px-3 py-1.5 on
   * a 13px line, which lands at 34px, so this is a 34px square rather than a
   * padded box that would drift when the row wraps.
   */
  shortcuts: {
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
     * public/marketing.css, which is UNLAYERED and which only the marketing
     * pages link: a shortcut sharing that prefix would work on a dashboard
     * page and lose to marketing.css on a marketing one. A name that file has
     * no claim on cannot be caught that way.
     */
    'empty-row': 'py-8 text-center text-sm text-text-3',
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
