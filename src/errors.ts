/**
 * Error classes mirroring the Python builtins that pluggy raises.
 * JavaScript has no ValueError/RuntimeError/AssertionError, so these
 * subclasses of Error stand in so callers can catch by type.
 */

export class ValueError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class RuntimeError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class AssertionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/** Mirrors Python's bare `assert cond, message`. */
export function assert_(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message);
  }
}
