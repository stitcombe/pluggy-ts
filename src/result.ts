/**
 * Hook wrapper "result" utilities.
 * Port of pluggy/_result.py.
 */

/** Hook was called incorrectly. */
export class HookCallError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "HookCallError";
  }
}

/**
 * The (class, exception, stack) triple exposed by `Result.excinfo`.
 * The Python original captures the traceback at Result creation time
 * because `__traceback__` is mutable; the JS `stack` string is immutable,
 * but we keep the captured copy for parity.
 */
export type ExcInfo = [new (...args: any[]) => any, unknown, string | undefined];

/**
 * An object used to inspect and set the result in a hook wrapper.
 */
export class Result<ResultType = unknown> {
  private _result: ResultType | null;
  private _exception: unknown;
  private _stack: string | undefined;

  constructor(result: ResultType | null, exception: unknown) {
    this._result = result;
    this._exception = exception;
    this._stack =
      exception instanceof Error ? exception.stack : undefined;
  }

  get excinfo(): ExcInfo | null {
    const exc = this._exception;
    if (exc == null) {
      return null;
    }
    return [(exc as object).constructor as new (...args: any[]) => any, exc, this._stack];
  }

  get exception(): unknown {
    return this._exception;
  }

  static from_call<T>(func: () => T): Result<T> {
    let result: T | null = null;
    let exception: unknown = null;
    try {
      result = func();
    } catch (exc) {
      exception = exc;
    }
    return new Result<T>(result, exception);
  }

  /**
   * Force the result(s) to `result`. If the hook was marked as a
   * `firstresult` a single value should be set, otherwise set a (modified)
   * list of results. Any exceptions found during invocation will be deleted.
   */
  force_result(result: ResultType): void {
    this._result = result;
    this._exception = null;
    this._stack = undefined;
  }

  /** Force the result to fail with `exception`. */
  force_exception(exception: unknown): void {
    this._result = null;
    this._exception = exception;
    this._stack = exception instanceof Error ? exception.stack : undefined;
  }

  /**
   * Get the result(s) for this hook call, re-raising any captured exception.
   */
  get_result(): ResultType {
    const exc = this._exception;
    if (exc == null) {
      return this._result as ResultType;
    }
    throw exc;
  }
}

// Historical name (pluggy<=1.2), kept for backward compatibility.
export const _Result = Result;
