/**
 * Lightweight, level-filtered logger used by every code path that
 * historically called `console.error` / `console.warn` / `console.debug`.
 *
 * Design goals:
 *   1. Production default: `error` and `warn` go to `console.*`,
 *      `info` and `debug` are silent.
 *   2. No performance cost when `debug` is disabled — call sites pass
 *      a thunk-shaped context for `debug`/`info` so the message doesn't
 *      get formatted unless it'll be printed.
 *   3. Pluggable: consumers can pass their own `LoroLogger` (e.g. a
 *      Sentry/Datadog/Pino wrapper) into `LoroSyncPluginProps.logger`
 *      and `LoroUndoPluginProps.logger`.
 *   4. No global state / module-level mutation — every plugin instance
 *      has its own logger. Hot-reload safe.
 */

export type LoroLogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface LoroLogger {
  /** Always-on by default. Use for unrecoverable errors. */
  error(message: string, context?: Record<string, unknown>): void;
  /** Always-on by default. Use for recoverable / soft failures. */
  warn(message: string, context?: Record<string, unknown>): void;
  /** Off by default. Use for plugin lifecycle milestones. */
  info(message: string, context?: Record<string, unknown>): void;
  /** Off by default. Use for hot-path tracing. */
  debug(message: string, context?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LoroLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Default factory: a console-backed logger filtered by level.
 *
 * Usage:
 * ```ts
 * LoroSyncPlugin({
 *   doc,
 *   logger: createConsoleLogger("debug"),  // verbose
 * });
 * LoroSyncPlugin({
 *   doc,
 *   logger: createConsoleLogger("warn"),   // production default
 * });
 * ```
 */
export function createConsoleLogger(
  level: LoroLogLevel = "warn",
  prefix = "[loro-prosemirror]",
): LoroLogger {
  const enabled = LEVEL_ORDER[level] ?? LEVEL_ORDER.warn;
  const fmt = (msg: string, ctx?: Record<string, unknown>) =>
    ctx == null ? [`${prefix} ${msg}`] : [`${prefix} ${msg}`, ctx];
  return {
    error:
      enabled >= LEVEL_ORDER.error
        ? (msg, ctx) => console.error(...fmt(msg, ctx))
        : noop,
    warn:
      enabled >= LEVEL_ORDER.warn
        ? (msg, ctx) => console.warn(...fmt(msg, ctx))
        : noop,
    info:
      enabled >= LEVEL_ORDER.info
        ? (msg, ctx) => console.info(...fmt(msg, ctx))
        : noop,
    debug:
      enabled >= LEVEL_ORDER.debug
        ? (msg, ctx) => console.debug(...fmt(msg, ctx))
        : noop,
  };
}

const noop = () => {};

/**
 * No-op logger. Useful in tests where any console output would be
 * noise, or in performance-sensitive paths where the logger is
 * threaded but logging is unwanted.
 */
export const silentLogger: LoroLogger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
};

/**
 * The fallback logger used when a plugin is constructed without a
 * `logger` prop. Production-safe defaults: `error` and `warn` print
 * via `console.*`; `info` and `debug` are silent.
 */
export const defaultLogger: LoroLogger = createConsoleLogger("warn");
