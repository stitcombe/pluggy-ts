/** Port of testing/test_invocations.py. */

import { beforeEach, describe, expect, test } from "vitest";
import {
  HookimplMarker,
  HookspecMarker,
  PluginManager,
  PluginValidationError,
  Result,
} from "../src/index.js";
import { makePm } from "./conftest.js";

const hookspec = new HookspecMarker("example");
const hookimpl = new HookimplMarker("example");

let pm: PluginManager;

beforeEach(() => {
  pm = makePm();
});

test("argmismatch", () => {
  const Api = {
    hello: hookspec(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);

  const plugin = {
    hello: hookimpl(function hello(argwrong: unknown) {}),
  };

  let error: unknown;
  try {
    pm.register(plugin);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(PluginValidationError);
  expect(String(error)).toContain("argwrong");
});

test("only kwargs", () => {
  const Api = {
    hello: hookspec(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);
  let error: unknown;
  try {
    (pm.hook.hello as any)(3);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect(String(error)).toContain(
    "__call__() takes 1 positional argument but 2 were given",
  );
});

test("opt-in args", () => {
  // Verify that two hookimpls with mutex args can serve under the same
  // spec.
  const Api = {
    hello: hookspec(function hello(
      arg1: unknown,
      arg2: unknown,
      common_arg: unknown,
    ) {
      /* api hook 1 */
    }),
  };

  const plugin1 = {
    hello: hookimpl(function hello(arg1: number, common_arg: number) {
      return arg1 + common_arg;
    }),
  };

  const plugin2 = {
    hello: hookimpl(function hello(arg2: number, common_arg: number) {
      return arg2 + common_arg;
    }),
  };

  pm.add_hookspecs(Api);
  pm.register(plugin1);
  pm.register(plugin2);

  const results = pm.hook.hello({ arg1: 1, arg2: 2, common_arg: 0 });
  expect(results).toEqual([2, 1]);
});

test("call order", () => {
  const Api = {
    hello: hookspec(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);

  const plugin1 = {
    hello: hookimpl(function hello(arg: unknown) {
      return 1;
    }),
  };
  const plugin2 = {
    hello: hookimpl(function hello(arg: unknown) {
      return 2;
    }),
  };
  const plugin3 = {
    hello: hookimpl(function hello(arg: unknown) {
      return 3;
    }),
  };
  const plugin4 = {
    hello: hookimpl({ hookwrapper: true })(function* hello(
      arg: number,
    ): Generator<undefined, void, Result<unknown>> {
      expect(arg).toBe(0);
      const outcome = yield;
      expect(outcome.get_result()).toEqual([3, 2, 1]);
      expect(outcome.exception).toBeNull();
      expect(outcome.excinfo).toBeNull();
    }),
  };
  const plugin5 = {
    hello: hookimpl({ wrapper: true })(function* hello(
      arg: number,
    ): Generator<undefined, any, any> {
      expect(arg).toBe(0);
      const result = yield;
      expect(result).toEqual([3, 2, 1]);
      return result;
    }),
  };

  pm.register(plugin1);
  pm.register(plugin2);
  pm.register(plugin3);
  pm.register(plugin4); // hookwrapper should get same list result
  pm.register(plugin5); // wrapper should get same list result
  const res = pm.hook.hello({ arg: 0 });
  expect(res).toEqual([3, 2, 1]);
});

test("firstresult definition", () => {
  const Api = {
    hello: hookspec({ firstresult: true })(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);

  const plugin1 = {
    hello: hookimpl(function hello(arg: number) {
      return arg + 1;
    }),
  };
  const plugin2 = {
    hello: hookimpl(function hello(arg: number) {
      return arg - 1;
    }),
  };
  const plugin3 = {
    hello: hookimpl(function hello(arg: unknown) {
      return null;
    }),
  };
  const plugin4 = {
    hello: hookimpl({ wrapper: true })(function* hello(
      arg: number,
    ): Generator<undefined, any, any> {
      expect(arg).toBe(3);
      const outcome = yield;
      expect(outcome).toBe(2);
      return outcome;
    }),
  };
  const plugin5 = {
    hello: hookimpl({ hookwrapper: true })(function* hello(
      arg: number,
    ): Generator<undefined, void, Result<unknown>> {
      expect(arg).toBe(3);
      const outcome = yield;
      expect(outcome.get_result()).toBe(2);
    }),
  };

  pm.register(plugin1); // discarded - not the last registered plugin
  pm.register(plugin2); // used as result
  pm.register(plugin3); // null result is ignored
  pm.register(plugin4); // wrapper should get same non-list result
  pm.register(plugin5); // hookwrapper should get same non-list result
  const res = pm.hook.hello({ arg: 3 });
  expect(res).toBe(2);
});

test("firstresult force result hookwrapper", () => {
  // Verify forcing a result in a wrapper.
  const Api = {
    hello: hookspec({ firstresult: true })(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);

  const plugin1 = {
    hello: hookimpl(function hello(arg: number) {
      return arg + 1;
    }),
  };
  const plugin2 = {
    hello: hookimpl({ hookwrapper: true })(function* hello(
      arg: number,
    ): Generator<undefined, void, Result<number>> {
      expect(arg).toBe(3);
      const outcome = yield;
      expect(outcome.get_result()).toBe(4);
      outcome.force_result(0);
    }),
  };
  const plugin3 = {
    hello: hookimpl(function hello(arg: unknown) {
      return null;
    }),
  };

  pm.register(plugin1);
  pm.register(plugin2); // wrapper
  pm.register(plugin3); // ignored since returns null
  const res = pm.hook.hello({ arg: 3 });
  expect(res).toBe(0); // this result is forced and not a list
});

test("firstresult force result", () => {
  // Verify forcing a result in a wrapper.
  const Api = {
    hello: hookspec({ firstresult: true })(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);

  const plugin1 = {
    hello: hookimpl(function hello(arg: number) {
      return arg + 1;
    }),
  };
  const plugin2 = {
    hello: hookimpl({ wrapper: true })(function* hello(
      arg: number,
    ): Generator<undefined, number, any> {
      expect(arg).toBe(3);
      const outcome = yield;
      expect(outcome).toBe(4);
      return 0;
    }),
  };
  const plugin3 = {
    hello: hookimpl(function hello(arg: unknown) {
      return null;
    }),
  };

  pm.register(plugin1);
  pm.register(plugin2); // wrapper
  pm.register(plugin3); // ignored since returns null
  const res = pm.hook.hello({ arg: 3 });
  expect(res).toBe(0); // this result is forced and not a list
});

test("firstresult returns none", () => {
  // If null results are returned by underlying implementations ensure the
  // multi-call loop returns a null value.
  const Api = {
    hello: hookspec({ firstresult: true })(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);

  const plugin1 = {
    hello: hookimpl(function hello(arg: unknown) {
      return null;
    }),
  };

  pm.register(plugin1);
  const res = pm.hook.hello({ arg: 3 });
  expect(res).toBeNull();
});

test("firstresult no plugin", () => {
  // If no implementations/plugins have been registered for a firstresult
  // hook the multi-call loop should return a null value.
  const Api = {
    hello: hookspec({ firstresult: true })(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);
  const res = pm.hook.hello({ arg: 3 });
  expect(res).toBeNull();
});

test("no hookspec", () => {
  // A hook with hookimpls can still be called even if no hookspec was
  // registered for it (and call_pending wasn't called to check against it).
  const plugin = {
    hello: hookimpl(function hello(arg: unknown) {
      return "Plugin.hello";
    }),
  };

  pm.register(plugin);

  expect(pm.hook.hello({ arg: 10, extra: 20 })).toEqual(["Plugin.hello"]);
});

test("non wrapper generator", () => {
  // A hookimpl can be a generator without being a wrapper, meaning it
  // returns an iterator result.
  const Api = {
    hello: hookspec(function hello() {
      throw new Error("NotImplementedError");
    }),
  };

  pm.add_hookspecs(Api);

  const plugin1 = {
    hello: hookimpl(function* hello() {
      yield 1;
    }),
  };
  const plugin2 = {
    hello: hookimpl(function* hello() {
      yield 2;
      yield 3;
    }),
  };
  const plugin3 = {
    hello: hookimpl({ wrapper: true })(function* hello(): Generator<
      undefined,
      any,
      any
    > {
      return yield;
    }),
  };

  pm.register(plugin1);
  pm.register(plugin2); // wrapper
  let res = pm.hook.hello() as Array<Iterable<number>>;
  expect(res.flatMap((x) => [...x])).toEqual([2, 3, 1]);
  pm.register(plugin3);
  res = pm.hook.hello() as Array<Iterable<number>>;
  expect(res.flatMap((x) => [...x])).toEqual([2, 3, 1]);
});

describe.each([
  ["wrapper", hookimpl({ wrapper: true })],
  ["legacy-wrapper", hookimpl({ hookwrapper: true })],
])("wrappers yield twice fails (%s)", (_id, kind) => {
  test("wrappers yield twice fails", () => {
    const plugin = {
      wrap: kind(function* wrap() {
        yield;
        yield;
      }),
    };

    pm.register(plugin);
    expect(() => pm.hook.wrap()).toThrow(
      /wrap_controller at 'wrap'.* has second yield/,
    );
  });
});

describe.each([
  ["wrapper", hookimpl({ wrapper: true })],
  ["legacy-wrapper", hookimpl({ hookwrapper: true })],
])("wrappers yield never fails (%s)", (_id, kind) => {
  test("wrappers yield never fails", () => {
    const plugin = {
      wrap: kind(function* wrap() {
        if (false as boolean) {
          yield;
        }
      }),
    };

    pm.register(plugin);
    expect(() => pm.hook.wrap()).toThrow(
      /wrap_controller at 'wrap'.* did not yield/,
    );
  });
});
