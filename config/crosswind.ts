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
  theme: {
    extend: {
      colors: {
        'bg': 'var(--bg)',
        'panel': 'var(--panel)',
        'border': 'var(--border)',
        'text': 'var(--text)',
        'text-2': 'var(--text-2)',
        'text-3': 'var(--text-3)',
        'accent': 'var(--accent)',
        'bar': 'var(--bar)',
      },
    },
  },
}
