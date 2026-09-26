/**
 * Names a render context can carry into a <script server> block, as AMBIENT
 * declarations (rule 10b).
 *
 * stx runs a server block as a function whose parameters are the keys of the
 * render context (variable-extractor.js, `Function(...scriptParams, body)`), so a
 * value a host renders a view with arrives as a bare name. The serve path's own
 * names -- `query`, `cookies`, `params` -- are declared by `stx typecheck` itself
 * (as `any`, which no declaration here can narrow; each page annotates the value
 * where it reads it instead). This file declares the ones that are this app's.
 *
 * Like `query`, each is absent on a render that did not supply it, so every read
 * is guarded with `typeof name !== 'undefined'`.
 */

/**
 * Dashboard data a host fetched itself and hands to dashboard.stx, which then
 * skips its own queries. Nothing in this repository injects it today: it is the
 * extension point the view has kept since it could render outside the API server.
 */
declare const preloaded: DashboardPreload | undefined
