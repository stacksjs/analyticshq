import type { CLI } from '@stacksjs/types'

/**
 * **CLI Listeners**
 *
 * Hook into `buddy` command lifecycle events here, e.g.
 * `cli.on('my-command:*', () => { ... })`.
 *
 * Empty on purpose. This file used to carry three `inspire:*` handlers from the
 * scaffold; `app/Commands/Inspire.ts` was removed in ee41406, so they listened
 * for a command that could no longer be run. The seam is kept because it is
 * where CLI listeners go, not because anything needs one today.
 */
export default function (_cli: CLI): void {
  //
}
