/**
 * Crosswind (utility CSS) — content globs for STX views.
 * @see https://github.com/cwcss/crosswind
 */
export default {
  content: [
    './resources/views/**/*.{stx,html}',
    './resources/**/*.{stx,html}',
    // Both of these are generated, gitignored directories — they exist after the
    // framework has run, not in a fresh checkout. Verified to resolve: 11 view
    // templates and 194 component templates.
    './storage/framework/defaults/resources/views/**/*.{stx,html}',
    './storage/framework/defaults/resources/components/**/*.{stx,html}',
    // storage/framework/core/error-handling/src/views was here and matched nothing.
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
