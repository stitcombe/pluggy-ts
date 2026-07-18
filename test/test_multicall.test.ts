/** Port of testing/test_multicall.py. */

import { describe, expect, test } from "vitest";
import { _multicall } from "../src/callers.js";
import { RuntimeError } from "../src/errors.js";
import {
  AnyFunction,
  HookImpl,
  HookimplMarker,
  HookspecMarker,
} from "../src/hooks.js";
import { HookCallError, Result } from "../src/result.js";

const hookspec = new HookspecMarker("example");
const hookimpl = new HookimplMarker("example");

// Stand-ins for Python exception types used by the original tests.
class ValueError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "ValueError";
  }
}
class SystemExit extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "SystemExit";
  }
}
class StopIteration extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "StopIteration";
  }
}

function MC(
  methods: AnyFunction[],
  kwargs: Record<string, unknown>,
  firstresult = false,
): unknown {
  const hookfuncs: HookImpl[] = [];
  for (const method of methods) {
    const f = new HookImpl(null, "<temp>", method, (method as any).example_impl);
    hookfuncs.push(f);
  }
  return _multicall("foo", hookfuncs, kwargs, firstresult);
}

test("keyword args", () => {
  const f = hookimpl(function f(x: number) {
    return x + 1;
  });

  // Python: a method on a class instance; `self` has no JS equivalent.
  const a = {
    f: hookimpl(function f(x: number, y: number) {
      return x + y;
    }),
  };

  const reslist = MC([f, a.f], { x: 23, y: 24 });
  expect(reslist).toEqual([24 + 23, 24]);
});

test("keyword args with defaultargs", () => {
  const f = hookimpl(function f(x: number, z = 1) {
    return x + z;
  });
  const reslist = MC([f], { x: 23, y: 24 });
  expect(reslist).toEqual([24]);
});

test("tags call error", () => {
  const f = hookimpl(function f(x: number) {
    return x;
  });
  expect(() => MC([f], {})).toThrow(HookCallError);
});

test("call none is no result", () => {
  const m1 = hookimpl(function m1() {
    return 1;
  });
  const m2 = hookimpl(function m2() {
    return null;
  });

  expect(MC([m1, m2], {}, true)).toBe(1);
  expect(MC([m1, m2], {}, false)).toEqual([1]);
});

test("hookwrapper", () => {
  const out: string[] = [];

  const m1 = hookimpl({ hookwrapper: true })(function* m1() {
    out.push("m1 init");
    yield null;
    out.push("m1 finish");
  });

  const m2 = hookimpl(function m2() {
    out.push("m2");
    return 2;
  });

  let res = MC([m2, m1], {});
  expect(res).toEqual([2]);
  expect(out).toEqual(["m1 init", "m2", "m1 finish"]);
  out.length = 0;
  res = MC([m2, m1], {}, true);
  expect(res).toBe(2);
  expect(out).toEqual(["m1 init", "m2", "m1 finish"]);
});

test("hookwrapper two yields", () => {
  const m = hookimpl({ hookwrapper: true })(function* m() {
    yield;
    yield;
  });

  expect(() => MC([m], {})).toThrow(/has second yield/);
});

test("wrapper", () => {
  const out: string[] = [];

  const m1 = hookimpl({ wrapper: true })(function* m1(): Generator<
    undefined,
    any,
    any
  > {
    out.push("m1 init");
    const result = yield;
    out.push("m1 finish");
    // Python's `result * 2` doubles the list in the list case and the
    // number in the firstresult case; spell both out in JS.
    return Array.isArray(result) ? [...result, ...result] : result * 2;
  });

  const m2 = hookimpl(function m2() {
    out.push("m2");
    return 2;
  });

  let res = MC([m2, m1], {});
  expect(res).toEqual([2, 2]);
  expect(out).toEqual(["m1 init", "m2", "m1 finish"]);
  out.length = 0;
  res = MC([m2, m1], {}, true);
  expect(res).toBe(4);
  expect(out).toEqual(["m1 init", "m2", "m1 finish"]);
});

test("wrapper two yields", () => {
  const m = hookimpl({ wrapper: true })(function* m() {
    yield;
    yield;
  });

  expect(() => MC([m], {})).toThrow(/has second yield/);
});

test("hookwrapper order", () => {
  const out: string[] = [];

  const m1 = hookimpl({ hookwrapper: true })(function* m1() {
    out.push("m1 init");
    yield 1;
    out.push("m1 finish");
  });

  const m2 = hookimpl({ wrapper: true })(function* m2(): Generator<
    number,
    any,
    any
  > {
    out.push("m2 init");
    const result = yield 2;
    out.push("m2 finish");
    return result;
  });

  const m3 = hookimpl({ hookwrapper: true })(function* m3() {
    out.push("m3 init");
    yield 3;
    out.push("m3 finish");
  });

  const m4 = hookimpl({ hookwrapper: true })(function* m4() {
    out.push("m4 init");
    yield 4;
    out.push("m4 finish");
  });

  const res = MC([m4, m3, m2, m1], {});
  expect(res).toEqual([]);
  expect(out).toEqual([
    "m1 init",
    "m2 init",
    "m3 init",
    "m4 init",
    "m4 finish",
    "m3 finish",
    "m2 finish",
    "m1 finish",
  ]);
});

test("hookwrapper not yield", () => {
  // Not a generator function at all: `next()` on its return value raises
  // TypeError, same as Python.
  const m1 = hookimpl({ hookwrapper: true })(function m1() {});

  expect(() => MC([m1], {})).toThrow(TypeError);
});

test("hookwrapper yield not executed", () => {
  const m1 = hookimpl({ hookwrapper: true })(function* m1() {
    if (false as boolean) {
      yield;
    }
  });

  expect(() => MC([m1], {})).toThrow(/did not yield/);
});

test("hookwrapper too many yield", () => {
  const m1 = hookimpl({ hookwrapper: true })(function* m1() {
    yield 1;
    yield 2;
  });

  let error: unknown;
  try {
    MC([m1], {});
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RuntimeError);
  // Python also asserts the source file path is in the message; JS
  // functions carry no such metadata, so only the name is checked.
  expect(String(error)).toContain("m1");
});

test("wrapper yield not executed", () => {
  const m1 = hookimpl({ wrapper: true })(function* m1() {
    if (false as boolean) {
      yield;
    }
  });

  expect(() => MC([m1], {})).toThrow(/did not yield/);
});

test("wrapper too many yield", () => {
  const out: string[] = [];

  const m1 = hookimpl({ wrapper: true })(function* m1() {
    try {
      yield 1;
      yield 2;
    } finally {
      out.push("cleanup");
    }
  });

  let error: unknown;
  try {
    try {
      MC([m1], {});
    } finally {
      out.push("finally");
    }
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RuntimeError);
  expect(String(error)).toContain("m1");
  expect(out).toEqual(["cleanup", "finally"]);
});

describe.each([
  ["ValueError", ValueError],
  ["SystemExit", SystemExit],
])("hookwrapper exception (%s)", (_name, exc) => {
  test("hookwrapper exception", () => {
    const out: string[] = [];

    const m1 = hookimpl({ hookwrapper: true })(function* m1(): Generator<
      undefined,
      void,
      Result<unknown>
    > {
      out.push("m1 init");
      const result = yield;
      expect(result.exception).toBeInstanceOf(exc);
      expect(result.excinfo![0]).toBe(exc);
      out.push("m1 finish");
    });

    const m2 = hookimpl(function m2() {
      throw new exc();
    });

    expect(() => MC([m2, m1], {})).toThrow(exc);
    expect(out).toEqual(["m1 init", "m1 finish"]);
  });
});

test("hookwrapper force exception", () => {
  const out: string[] = [];

  const m1 = hookimpl({ hookwrapper: true })(function* m1(): Generator<
    undefined,
    void,
    Result<unknown>
  > {
    out.push("m1 init");
    const result = yield;
    try {
      result.get_result();
    } catch (exc) {
      result.force_exception(exc);
    }
    out.push("m1 finish");
  });

  const m2 = hookimpl({ hookwrapper: true })(function* m2(): Generator<
    undefined,
    void,
    Result<unknown>
  > {
    out.push("m2 init");
    const result = yield;
    try {
      result.get_result();
    } catch (exc) {
      const new_exc = new Error("m2");
      (new_exc as any).cause = exc;
      result.force_exception(new_exc);
    }
    out.push("m2 finish");
  });

  const m3 = hookimpl({ hookwrapper: true })(function* m3() {
    out.push("m3 init");
    yield;
    out.push("m3 finish");
  });

  const m4 = hookimpl(function m4() {
    throw new ValueError("m4");
  });

  let error: unknown;
  try {
    MC([m4, m3, m2, m1], {});
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("m2");
  expect(out).toEqual([
    "m1 init",
    "m2 init",
    "m3 init",
    "m3 finish",
    "m2 finish",
    "m1 finish",
  ]);
  expect((error as any).cause).toBeDefined();
  expect(String((error as any).cause.message)).toBe("m4");
});

describe.each([
  ["ValueError", ValueError],
  ["SystemExit", SystemExit],
])("wrapper exception (%s)", (_name, exc) => {
  test("wrapper exception", () => {
    const out: string[] = [];

    const m1 = hookimpl({ wrapper: true })(function* m1(): Generator<
      undefined,
      any,
      any
    > {
      out.push("m1 init");
      let result;
      try {
        result = yield;
      } catch (e) {
        expect(e).toBeInstanceOf(exc);
        throw e;
      } finally {
        out.push("m1 finish");
      }
      return result;
    });

    const m2 = hookimpl(function m2() {
      out.push("m2 init");
      throw new exc();
    });

    expect(() => MC([m2, m1], {})).toThrow(exc);
    expect(out).toEqual(["m1 init", "m2 init", "m1 finish"]);
  });
});

test("wrapper exception chaining", () => {
  const m1 = hookimpl(function m1() {
    throw new Error("m1");
  });

  const m2 = hookimpl({ wrapper: true })(function* m2() {
    try {
      yield;
    } catch {
      throw new Error("m2");
    }
  });

  const m3 = hookimpl({ wrapper: true })(function* m3(): Generator<
    undefined,
    number,
    any
  > {
    yield;
    return 10;
  });

  const m4 = hookimpl({ wrapper: true })(function* m4() {
    try {
      yield;
    } catch (e) {
      throw new Error("m4", { cause: e });
    }
  });

  let error: unknown;
  try {
    MC([m1, m2, m3, m4], {});
  } catch (e) {
    error = e;
  }
  expect((error as Error).message).toBe("m4");
  const cause = (error as Error).cause as Error;
  expect(cause).toBeDefined();
  expect(cause.message).toBe("m2");
  // Implicit chaining (Python __context__) is emulated by the call loop.
  const context = (cause as any).__context__ as Error;
  expect(context).toBeDefined();
  expect(context.message).toBe("m1");
});

test("unwind inner wrapper teardown exc", () => {
  const out: string[] = [];

  const m1 = hookimpl({ wrapper: true })(function* m1() {
    out.push("m1 init");
    try {
      yield;
      out.push("m1 unreachable");
    } catch (e) {
      out.push("m1 teardown");
      throw e;
    } finally {
      out.push("m1 cleanup");
    }
  });

  const m2 = hookimpl({ wrapper: true })(function* m2() {
    out.push("m2 init");
    yield;
    out.push("m2 raise");
    throw new ValueError();
  });

  let error: unknown;
  try {
    try {
      MC([m2, m1], {});
    } finally {
      out.push("finally");
    }
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ValueError);

  expect(out).toEqual([
    "m1 init",
    "m2 init",
    "m2 raise",
    "m1 teardown",
    "m1 cleanup",
    "finally",
  ]);
});

describe.each([[true], [false]])(
  "wrapper stopiteration passtrough (has_hookwrapper=%s)",
  (has_hookwrapper) => {
    test("wrapper stopiteration passtrough", () => {
      // In Python, StopIteration cannot propagate through a generator's
      // throw() and needs special-casing (#544). JavaScript has no such
      // trap; a StopIteration-like error passes through like any other.
      const out: string[] = [];

      const wrap = hookimpl({ wrapper: true })(function* wrap() {
        out.push("wrap");
        try {
          yield;
        } finally {
          out.push("wrap done");
        }
      });

      const wrap_path2 = hookimpl({
        wrapper: !has_hookwrapper,
        hookwrapper: has_hookwrapper,
      })(function* wrap_path2() {
        yield;
      });

      const stop = hookimpl(function stop() {
        out.push("stop");
        throw new StopIteration();
      });

      let error: unknown;
      try {
        try {
          MC([stop, wrap, wrap_path2], {});
        } finally {
          out.push("finally");
        }
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(StopIteration);

      expect(out).toEqual(["wrap", "stop", "wrap done", "finally"]);
    });
  },
);

test("suppress inner wrapper teardown exc", () => {
  const out: string[] = [];

  const m1 = hookimpl({ wrapper: true })(function* m1(): Generator<
    undefined,
    any,
    any
  > {
    out.push("m1 init");
    const result = yield;
    out.push("m1 finish");
    return result;
  });

  const m2 = hookimpl({ wrapper: true })(function* m2(): Generator<
    undefined,
    any,
    any
  > {
    out.push("m2 init");
    try {
      yield;
      out.push("m2 unreachable");
    } catch (e) {
      if (e instanceof ValueError) {
        out.push("m2 suppress");
        return 22;
      }
      throw e;
    }
  });

  const m3 = hookimpl({ wrapper: true })(function* m3() {
    out.push("m3 init");
    yield;
    out.push("m3 raise");
    throw new ValueError();
  });

  expect(MC([m3, m2, m1], {})).toBe(22);
  expect(out).toEqual([
    "m1 init",
    "m2 init",
    "m3 init",
    "m3 raise",
    "m2 suppress",
    "m1 finish",
  ]);
});
