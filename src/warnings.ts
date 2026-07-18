/**
 * Warning classes and a minimal emulation of Python's `warnings` module.
 *
 * Python's pluggy emits non-fatal diagnostics through `warnings.warn()`.
 * JavaScript has no equivalent channel, so this module provides one: a
 * global list of subscribers which receive every emitted warning. The
 * default behavior (no subscribers) writes to `console.warn`, mirroring
 * Python's default of printing to stderr.
 */

/** Base warning class, analogous to Python's `Warning`. */
export class Warning extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Analogous to Python's `UserWarning` (the default warning category). */
export class UserWarning extends Warning {}

/** Analogous to Python's `DeprecationWarning`. */
export class DeprecationWarning extends Warning {}

/** Base class for all warnings emitted by pluggy. */
export class PluggyWarning extends UserWarning {}

/**
 * A plugin raised an exception during an old-style hookwrapper teardown.
 *
 * Such exceptions are not handled by pluggy, and may cause subsequent
 * teardowns to be executed at unexpected times, or be skipped entirely.
 */
export class PluggyTeardownRaisedWarning extends PluggyWarning {}

export type WarningHandler = (warning: Warning) => void;

const handlers: WarningHandler[] = [];

/**
 * Emit a warning. If `message` is a string it is wrapped in an instance of
 * `category` (default `UserWarning`), mirroring `warnings.warn()`.
 */
export function warn(
  message: string | Warning,
  category: new (message?: string) => Warning = UserWarning,
): void {
  const warning = typeof message === "string" ? new category(message) : message;
  if (handlers.length === 0) {
    console.warn(`${warning.name}: ${warning.message}`);
  } else {
    for (const handler of handlers) {
      handler(warning);
    }
  }
}

/**
 * Subscribe to warnings; returns an unsubscribe function. While at least
 * one subscriber is installed, warnings are not printed to the console.
 */
export function addWarningHandler(handler: WarningHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i !== -1) {
      handlers.splice(i, 1);
    }
  };
}

/**
 * Run `fn` while recording all warnings it emits, analogous to Python's
 * `warnings.catch_warnings(record=True)`. Warnings are suppressed from
 * other handlers for the duration of the call.
 */
export function catchWarnings<T>(fn: () => T): { result: T; warnings: Warning[] } {
  const recorded: Warning[] = [];
  const saved = handlers.splice(0, handlers.length);
  handlers.push((w) => recorded.push(w));
  try {
    const result = fn();
    return { result, warnings: recorded };
  } finally {
    handlers.splice(0, handlers.length);
    handlers.push(...saved);
  }
}
