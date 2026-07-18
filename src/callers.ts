/**
 * Call loop machinery.
 * Port of pluggy/_callers.py.
 *
 * Wrappers are JavaScript generator functions, mirroring Python generators:
 * `gen.next(v)` plays the role of `send`, `gen.throw(e)` of `throw`, and
 * `gen.return()` of `close`. Where Python signals generator completion with
 * a StopIteration exception, JavaScript reports `{done: true, value}`.
 *
 * Python chains exceptions implicitly (`__context__`) when a teardown
 * raises while another exception is in flight; JavaScript has no implicit
 * chaining, so this module emulates it by setting a `__context__` property
 * on the newly raised error.
 */

import { RuntimeError } from "./errors.js";
import type { HookImpl } from "./hooks.js";
import { HookCallError, Result } from "./result.js";
import { warn, PluggyTeardownRaisedWarning } from "./warnings.js";

export type TeardownGen = Generator<unknown, unknown, unknown>;

interface Teardown {
  gen: TeardownGen;
  /** Name of the plugin's wrapper function, for error messages. */
  fname: string;
}

function functionName(fn: (...args: unknown[]) => unknown): string {
  return fn.name || "<anonymous>";
}

function _raise_wrapfail(fname: string, msg: string): never {
  throw new RuntimeError(`wrap_controller at '${fname}' ${msg}`);
}

function _warn_teardown_exception(
  hook_name: string,
  hook_impl: HookImpl,
  e: unknown,
): void {
  const excName =
    e instanceof Error ? e.name : (e as any)?.constructor?.name ?? typeof e;
  const excMessage = e instanceof Error ? e.message : String(e);
  const msg =
    "A plugin raised an exception during an old-style hookwrapper teardown.\n" +
    `Plugin: ${hook_impl.plugin_name}, Hook: ${hook_name}\n` +
    `${excName}: ${excMessage}\n` +
    "For more information see https://pluggy.readthedocs.io/en/stable/api_reference.html#pluggy.PluggyTeardownRaisedWarning";
  warn(new PluggyTeardownRaisedWarning(msg));
}

/**
 * Backward compatibility wrapper to run an old-style hookwrapper as a
 * (new-style) wrapper. The plugin's generator receives a `Result` object at
 * its yield point instead of the plain result value.
 */
export function* run_old_style_hookwrapper(
  hook_impl: HookImpl,
  hook_name: string,
  args: unknown[],
): TeardownGen {
  const fname = functionName(hook_impl.function);
  const teardown = hook_impl.function.apply(
    hook_impl.plugin,
    args,
  ) as TeardownGen;
  // `teardown.next` throws TypeError if the impl is not a generator,
  // matching Python's `next(teardown)`.
  const first = teardown.next();
  if (first.done) {
    _raise_wrapfail(fname, "did not yield");
  }
  let result: Result<unknown>;
  try {
    const res = yield;
    result = new Result(res, null);
  } catch (exc) {
    result = new Result(null, exc);
  }
  try {
    let sent: IteratorResult<unknown>;
    try {
      sent = teardown.next(result);
    } catch (e) {
      _warn_teardown_exception(hook_name, hook_impl, e);
      throw e;
    }
    if (!sent.done) {
      _raise_wrapfail(fname, "has second yield");
    }
  } finally {
    teardown.return(undefined);
  }
  return result.get_result();
}

/**
 * Execute a call into multiple functions/methods and return the result(s).
 *
 * `caller_kwargs` comes from HookCaller.__call__().
 */
export function _multicall(
  hook_name: string,
  hook_impls: readonly HookImpl[],
  caller_kwargs: Record<string, unknown>,
  firstresult: boolean,
): unknown {
  const results: unknown[] = [];
  let exception: unknown = null;
  let hasException = false;
  const teardowns: Teardown[] = [];
  let result: unknown;
  try {
    // run impl and wrapper setup functions in a loop
    for (let idx = hook_impls.length - 1; idx >= 0; idx--) {
      const hook_impl = hook_impls[idx];
      const args: unknown[] = [];
      for (const argname of hook_impl.argnames) {
        if (!(argname in caller_kwargs)) {
          throw new HookCallError(
            `hook call must provide argument '${argname}'`,
          );
        }
        args.push(caller_kwargs[argname]);
      }

      if (hook_impl.hookwrapper) {
        const function_gen = run_old_style_hookwrapper(
          hook_impl,
          hook_name,
          args,
        );
        function_gen.next(); // first yield
        teardowns.push({
          gen: function_gen,
          fname: functionName(hook_impl.function),
        });
      } else if (hook_impl.wrapper) {
        const function_gen = hook_impl.function.apply(
          hook_impl.plugin,
          args,
        ) as TeardownGen;
        // `function_gen.next` throws TypeError if the impl is not a
        // generator, matching Python.
        const first = function_gen.next(); // first yield
        if (first.done) {
          _raise_wrapfail(functionName(hook_impl.function), "did not yield");
        }
        teardowns.push({
          gen: function_gen,
          fname: functionName(hook_impl.function),
        });
      } else {
        const res = hook_impl.function.apply(hook_impl.plugin, args);
        if (res != null) {
          results.push(res);
          if (firstresult) {
            // halt further impl calls
            break;
          }
        }
      }
    }
  } catch (exc) {
    exception = exc;
    hasException = true;
  } finally {
    if (firstresult) {
      // first result hooks return a single value
      result = results.length ? results[0] : null;
    } else {
      result = results;
    }

    // run all wrapper post-yield blocks
    for (let idx = teardowns.length - 1; idx >= 0; idx--) {
      const { gen: teardown, fname } = teardowns[idx];
      try {
        let step: IteratorResult<unknown>;
        if (hasException) {
          step = teardown.throw(exception);
        } else {
          step = teardown.next(result);
        }
        if (step.done) {
          // Generator completed: adopt its return value as the result
          // (Python: StopIteration.value).
          result = step.value;
          exception = null;
          hasException = false;
          continue;
        }
        // Following is unreachable for a well behaved hook wrapper.
        // Try to force finalizers otherwise postponed till GC action.
        // Note: return() may throw if the generator handles GeneratorExit.
        teardown.return(undefined);
      } catch (e) {
        // Emulate Python's implicit exception chaining: remember the
        // exception that was in flight when this one was raised.
        if (
          hasException &&
          e !== exception &&
          e instanceof Error &&
          (e as any).__context__ === undefined
        ) {
          (e as any).__context__ = exception;
        }
        exception = e;
        hasException = true;
        continue;
      }
      // Raised outside the try/catch, like Python: a misbehaving wrapper
      // aborts the remaining teardowns immediately.
      _raise_wrapfail(fname, "has second yield");
    }
  }

  if (hasException) {
    throw exception;
  } else {
    return result;
  }
}
