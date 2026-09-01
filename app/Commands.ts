export interface CommandConfig {
  /** The command file name (without .ts extension) */
  file: string
  /** Whether the command is enabled */
  enabled?: boolean
  /** Command aliases */
  aliases?: string[]
}

export type CommandRegistry = Record<string, string | CommandConfig>

/**
 * The application's command registry.
 *
 * Commands listed here will be auto-loaded by the CLI.
 * You can use a simple string (file name) or a config object for more control.
 *
 * @example
 * // Simple registration
 * 'inspire': 'Inspire',
 *
 * // With config
 * 'send-emails': {
 *   file: 'SendEmails',
 *   enabled: true,
 *   aliases: ['emails', 'mail'],
 * },
 */
// Empty on purpose. This app registers no commands of its own; `buddy` iterates
// the registry and finds nothing, which is the intended no-op. Do not delete the
// file to express that — an import that throws sends buddy down its
// auto-discovery branch over app/Commands/, which is a different behaviour.
export default {} satisfies CommandRegistry
