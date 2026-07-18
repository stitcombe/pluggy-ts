/** Port of testing/test_hookcaller.py. */

import { beforeEach, expect, test } from "vitest";
import { ValueError } from "../src/errors.js";
import {
  AnyFunction,
  HookCaller,
  HookImpl,
  HookimplMarker,
  HookspecMarker,
} from "../src/hooks.js";
import { PluginManager, PluginValidationError } from "../src/index.js";
import { makePm } from "./conftest.js";

const hookspec = new HookspecMarker("example");
const hookimpl = new HookimplMarker("example");

let pm: PluginManager;
let hc: HookCaller;
let addmeth: (opts?: {
  tryfirst?: boolean;
  trylast?: boolean;
  hookwrapper?: boolean;
  wrapper?: boolean;
}) => <F extends AnyFunction>(func: F) => F;

beforeEach(() => {
  pm = makePm();

  const Hooks = {
    he_method1: hookspec(function he_method1(arg: unknown) {}),
  };
  pm.add_hookspecs(Hooks);
  hc = pm.hook.he_method1;

  addmeth = (opts = {}) => {
    return <F extends AnyFunction>(func: F): F => {
      hookimpl({
        tryfirst: opts.tryfirst ?? false,
        trylast: opts.trylast ?? false,
        hookwrapper: opts.hookwrapper ?? false,
        wrapper: opts.wrapper ?? false,
      })(func);
      hc._add_hookimpl(
        new HookImpl(null, "<temp>", func, (func as any).example_impl),
      );
      return func;
    };
  };
});

function funcs(hookmethods: HookImpl[]): AnyFunction[] {
  return hookmethods.map((hookmethod) => hookmethod.function);
}

test("adding nonwrappers", () => {
  const he_method1 = addmeth()(function he_method1() {});
  const he_method2 = addmeth()(function he_method2() {});
  const he_method3 = addmeth()(function he_method3() {});

  expect(funcs(hc.get_hookimpls())).toEqual([he_method1, he_method2, he_method3]);
});

test("adding nonwrappers trylast", () => {
  const he_method1_middle = addmeth()(function he_method1_middle() {});
  const he_method1 = addmeth({ trylast: true })(function he_method1() {});
  const he_method1_b = addmeth()(function he_method1_b() {});

  expect(funcs(hc.get_hookimpls())).toEqual([
    he_method1,
    he_method1_middle,
    he_method1_b,
  ]);
});

test("adding nonwrappers trylast3", () => {
  const he_method1_a = addmeth()(function he_method1_a() {});
  const he_method1_b = addmeth({ trylast: true })(function he_method1_b() {});
  const he_method1_c = addmeth()(function he_method1_c() {});
  const he_method1_d = addmeth({ trylast: true })(function he_method1_d() {});

  expect(funcs(hc.get_hookimpls())).toEqual([
    he_method1_d,
    he_method1_b,
    he_method1_a,
    he_method1_c,
  ]);
});

test("adding nonwrappers trylast2", () => {
  const he_method1_middle = addmeth()(function he_method1_middle() {});
  const he_method1_b = addmeth()(function he_method1_b() {});
  const he_method1 = addmeth({ trylast: true })(function he_method1() {});

  expect(funcs(hc.get_hookimpls())).toEqual([
    he_method1,
    he_method1_middle,
    he_method1_b,
  ]);
});

test("adding nonwrappers tryfirst", () => {
  const he_method1 = addmeth({ tryfirst: true })(function he_method1() {});
  const he_method1_middle = addmeth()(function he_method1_middle() {});
  const he_method1_b = addmeth()(function he_method1_b() {});

  expect(funcs(hc.get_hookimpls())).toEqual([
    he_method1_middle,
    he_method1_b,
    he_method1,
  ]);
});

test("adding wrappers ordering", () => {
  const he_method1 = addmeth({ hookwrapper: true })(function* he_method1() {
    yield;
  });
  const he_method1_fun = addmeth({ wrapper: true })(function* he_method1_fun() {
    yield;
  });
  const he_method1_middle = addmeth()(function he_method1_middle() {});
  const he_method3_fun = addmeth({ hookwrapper: true })(function* he_method3_fun() {
    yield;
  });
  const he_method3 = addmeth({ hookwrapper: true })(function* he_method3() {
    yield;
  });

  expect(funcs(hc.get_hookimpls())).toEqual([
    he_method1_middle,
    he_method1,
    he_method1_fun,
    he_method3_fun,
    he_method3,
  ]);
});

test("adding wrappers ordering tryfirst", () => {
  const he_method1 = addmeth({ hookwrapper: true, tryfirst: true })(
    function* he_method1() {
      yield;
    },
  );
  const he_method2 = addmeth({ hookwrapper: true })(function* he_method2() {
    yield;
  });
  const he_method3 = addmeth({ wrapper: true, tryfirst: true })(
    function* he_method3() {
      yield;
    },
  );

  expect(funcs(hc.get_hookimpls())).toEqual([he_method2, he_method1, he_method3]);
});

test("adding wrappers complex", () => {
  expect(funcs(hc.get_hookimpls())).toEqual([]);

  const m1 = addmeth({ hookwrapper: true, trylast: true })(function* m1() {
    yield;
  });
  expect(funcs(hc.get_hookimpls())).toEqual([m1]);

  const m2 = addmeth()(function m2() {});
  expect(funcs(hc.get_hookimpls())).toEqual([m2, m1]);

  const m3 = addmeth({ trylast: true })(function m3() {});
  expect(funcs(hc.get_hookimpls())).toEqual([m3, m2, m1]);

  const m4 = addmeth({ hookwrapper: true })(function* m4() {
    yield;
  });
  expect(funcs(hc.get_hookimpls())).toEqual([m3, m2, m1, m4]);

  const m5 = addmeth({ wrapper: true, tryfirst: true })(function* m5() {
    yield;
  });
  expect(funcs(hc.get_hookimpls())).toEqual([m3, m2, m1, m4, m5]);

  const m6 = addmeth({ tryfirst: true })(function m6() {});
  expect(funcs(hc.get_hookimpls())).toEqual([m3, m2, m6, m1, m4, m5]);

  const m7 = addmeth()(function m7() {});
  expect(funcs(hc.get_hookimpls())).toEqual([m3, m2, m7, m6, m1, m4, m5]);

  const m8 = addmeth({ wrapper: true })(function* m8() {
    yield;
  });
  expect(funcs(hc.get_hookimpls())).toEqual([m3, m2, m7, m6, m1, m4, m8, m5]);

  const m9 = addmeth({ trylast: true })(function m9() {});
  expect(funcs(hc.get_hookimpls())).toEqual([m9, m3, m2, m7, m6, m1, m4, m8, m5]);

  const m10 = addmeth({ tryfirst: true })(function m10() {});
  expect(funcs(hc.get_hookimpls())).toEqual([
    m9, m3, m2, m7, m6, m10, m1, m4, m8, m5,
  ]);

  const m11 = addmeth({ hookwrapper: true, trylast: true })(function* m11() {
    yield;
  });
  expect(funcs(hc.get_hookimpls())).toEqual([
    m9, m3, m2, m7, m6, m10, m11, m1, m4, m8, m5,
  ]);

  const m12 = addmeth({ wrapper: true })(function* m12() {
    yield;
  });
  expect(funcs(hc.get_hookimpls())).toEqual([
    m9, m3, m2, m7, m6, m10, m11, m1, m4, m8, m12, m5,
  ]);

  const m13 = addmeth()(function m13() {});
  expect(funcs(hc.get_hookimpls())).toEqual([
    m9, m3, m2, m7, m13, m6, m10, m11, m1, m4, m8, m12, m5,
  ]);
});

test("hookspec", () => {
  const HookSpecNs = {
    he_myhook1: hookspec()(function he_myhook1(arg1: unknown) {}),
    he_myhook2: hookspec({ firstresult: true })(function he_myhook2(
      arg1: unknown,
    ) {}),
    he_myhook3: hookspec({ firstresult: false })(function he_myhook3(
      arg1: unknown,
    ) {}),
  };

  pm.add_hookspecs(HookSpecNs);
  expect(pm.hook.he_myhook1.spec).not.toBeNull();
  expect(pm.hook.he_myhook1.spec!.opts.firstresult).toBe(false);
  expect(pm.hook.he_myhook2.spec).not.toBeNull();
  expect(pm.hook.he_myhook2.spec!.opts.firstresult).toBe(true);
  expect(pm.hook.he_myhook3.spec).not.toBeNull();
  expect(pm.hook.he_myhook3.spec!.opts.firstresult).toBe(false);
});

test.each(
  (["hookwrapper", "optionalhook", "tryfirst", "trylast"] as const).flatMap(
    (name) => [true, false].map((val) => [name, val] as const),
  ),
)("hookimpl (%s=%s)", (name, val) => {
  const he_myhook1 = hookimpl({ [name]: val })(function he_myhook1(
    arg1: unknown,
  ) {});
  if (val) {
    expect((he_myhook1 as any).example_impl[name]).toBeTruthy();
  } else {
    expect(name in he_myhook1).toBe(false);
  }
});

test("hookrelay registry", () => {
  // Verify hook caller instances are registered by name onto the relay
  // and can be likewise unregistered.
  const Api = {
    hello: hookspec(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);
  const hook = pm.hook;
  expect("hello" in hook).toBe(true);
  expect(String(hook.hello)).toContain("hello");

  const plugin = {
    hello: hookimpl(function hello(arg: number) {
      return arg + 1;
    }),
  };

  pm.register(plugin);
  const out = hook.hello({ arg: 3 });
  expect(out).toEqual([4]);
  expect("world" in hook).toBe(false);
  pm.unregister(plugin);
  expect(hook.hello({ arg: 3 })).toEqual([]);
});

test("hookrelay registration by specname", () => {
  // Verify hook caller instances may also be registered by specifying a
  // specname option to the hookimpl.
  const Api = {
    hello: hookspec(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);
  const hook = pm.hook;
  expect("hello" in hook).toBe(true);
  expect(pm.hook.hello.get_hookimpls().length).toBe(0);

  const plugin = {
    foo: hookimpl({ specname: "hello" })(function foo(arg: number) {
      return arg + 1;
    }),
  };

  pm.register(plugin);
  const out = hook.hello({ arg: 3 });
  expect(out).toEqual([4]);
});

test("hookrelay registration by specname raises", () => {
  // Verify using specname still raises the types of errors during
  // registration as it would have without using specname.
  const Api = {
    hello: hookspec(function hello(arg: unknown) {
      /* api hook 1 */
    }),
  };

  pm.add_hookspecs(Api);

  // make sure a bad signature still raises an error when using specname
  const plugin = {
    foo: hookimpl({ specname: "hello" })(function foo(
      arg: number,
      too: unknown,
      many: unknown,
      args: unknown,
    ) {
      return arg + 1;
    }),
  };

  expect(() => pm.register(plugin)).toThrow(PluginValidationError);

  // make sure check_pending still fails if specname doesn't have a
  // corresponding spec. EVEN if the function name matches one.
  const plugin2 = {
    hello: hookimpl({ specname: "bar" })(function hello(arg: number) {
      return arg + 1;
    }),
  };

  pm.register(plugin2);
  expect(() => pm.check_pending()).toThrow(PluginValidationError);
});

test("hook conflict", () => {
  class Api1 {
    conflict(): void {}
  }
  hookspec(Api1.prototype.conflict);

  class Api2 {
    conflict(): void {}
  }
  hookspec(Api2.prototype.conflict);

  pm.add_hookspecs(Api1);
  let error: unknown;
  try {
    pm.add_hookspecs(Api2);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ValueError);
  expect((error as Error).message).toBe(
    "Hook 'conflict' is already registered within namespace <class 'Api1'>",
  );
});

test("call extra hook order", () => {
  // Ensure that call_extra is calling hooks in the right order.
  const order: string[] = [];

  addmeth({ tryfirst: true })(function method1() {
    order.push("1");
    return "1";
  });
  addmeth()(function method2() {
    order.push("2");
    return "2";
  });
  addmeth({ trylast: true })(function method3() {
    order.push("3");
    return "3";
  });
  addmeth({ wrapper: true, tryfirst: true })(function* method4(): Generator<
    undefined,
    any,
    any
  > {
    order.push("4pre");
    const result = yield;
    order.push("4post");
    return result;
  });
  addmeth({ wrapper: true })(function* method5(): Generator<
    undefined,
    any,
    any
  > {
    order.push("5pre");
    const result = yield;
    order.push("5post");
    return result;
  });
  addmeth({ wrapper: true, trylast: true })(function* method6(): Generator<
    undefined,
    any,
    any
  > {
    order.push("6pre");
    const result = yield;
    order.push("6post");
    return result;
  });

  function extra1(): string {
    order.push("extra1");
    return "extra1";
  }

  function extra2(): string {
    order.push("extra2");
    return "extra2";
  }

  const result = hc.call_extra([extra1, extra2], { arg: "test" });
  expect(order).toEqual([
    "4pre",
    "5pre",
    "6pre",
    "1",
    "extra2",
    "extra1",
    "2",
    "3",
    "6post",
    "5post",
    "4post",
  ]);
  expect(result).toEqual(["1", "extra2", "extra1", "2", "3"]);
});
