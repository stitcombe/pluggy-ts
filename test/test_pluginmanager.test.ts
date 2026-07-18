/** Port of testing/test_pluginmanager.py. */

import { beforeEach, describe, expect, test } from "vitest";
import { AssertionError } from "../src/errors.js";
import {
  HookCallError,
  HookimplMarker,
  HookspecMarker,
  PluginManager,
  PluginValidationError,
  Result,
  setDistributions,
  UserWarning,
  ValueError,
} from "../src/index.js";
import {
  makeHePm,
  makePm,
  recordWarnings,
  SPEC_FORMS,
  SpecForm,
} from "./conftest.js";

const hookspec = new HookspecMarker("example");
const hookimpl = new HookimplMarker("example");

let pm: PluginManager;

beforeEach(() => {
  pm = makePm();
});

test("plugin double register", () => {
  // Registering the same plugin more than once isn't allowed.
  pm.register(42, "abc");
  expect(() => pm.register(42, "abc")).toThrow(ValueError);
  expect(() => pm.register(42, "def")).toThrow(ValueError);
});

test("pm", () => {
  // Basic registration with objects.
  class A {}

  const a1 = new A();
  const a2 = new A();
  pm.register(a1);
  expect(pm.is_registered(a1)).toBe(true);
  pm.register(a2, "hello");
  expect(pm.is_registered(a2)).toBe(true);
  const out = pm.get_plugins();
  expect(out.has(a1)).toBe(true);
  expect(out.has(a2)).toBe(true);
  expect(pm.get_plugin("hello")).toBe(a2);
  expect(pm.unregister(a1)).toBe(a1);
  expect(pm.is_registered(a1)).toBe(false);

  const out2 = pm.list_name_plugin();
  expect(out2.length).toBe(1);
  expect(out2).toEqual([["hello", a2]]);
});

test("has plugin", () => {
  class A {}

  const a1 = new A();
  pm.register(a1, "hello");
  expect(pm.is_registered(a1)).toBe(true);
  expect(pm.has_plugin("hello")).toBe(true);
});

describe.each(SPEC_FORMS)("he_pm (%s)", (specForm: SpecForm) => {
  let he_pm: PluginManager;

  beforeEach(() => {
    he_pm = makeHePm(pm, specForm);
  });

  test("register dynamic attr", () => {
    // Python: a class whose __getattr__ returns 42 for any non-underscore
    // attribute. JS analog: a Proxy with a get trap.
    const a = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === "string" && prop[0] !== "_") {
            return 42;
          }
          return undefined;
        },
      },
    );

    (a as any).test;

    he_pm.register(a);
    expect(he_pm.get_hookcallers(a)).toEqual([]);
  });

  test("register mismatch method", () => {
    class hello {
      he_method_notexists(): void {}
    }
    hookimpl(hello.prototype.he_method_notexists);

    const plugin = new hello();

    he_pm.register(plugin);
    let error: unknown;
    try {
      he_pm.check_pending();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PluginValidationError);
    expect((error as PluginValidationError).plugin).toBe(plugin);
  });

  test("register mismatch arg", () => {
    class hello {
      he_method1(qlwkje: unknown): void {}
    }
    hookimpl(hello.prototype.he_method1);

    const plugin = new hello();

    let error: unknown;
    try {
      he_pm.register(plugin);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PluginValidationError);
    expect((error as PluginValidationError).plugin).toBe(plugin);
  });

  test("register hookwrapper not a generator function", () => {
    class hello {
      he_method1(): void {}
    }
    hookimpl({ hookwrapper: true })(hello.prototype.he_method1);

    const plugin = new hello();

    let error: unknown;
    try {
      he_pm.register(plugin);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PluginValidationError);
    expect(String(error)).toMatch(/generator function/);
    expect((error as PluginValidationError).plugin).toBe(plugin);
  });

  test("register both wrapper and hookwrapper", () => {
    const heMethod1 = function* he_method1() {
      yield;
    };
    class hello {
      he_method1 = hookimpl({ wrapper: true, hookwrapper: true })(heMethod1);
    }

    const plugin = new hello();

    let error: unknown;
    try {
      he_pm.register(plugin);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PluginValidationError);
    expect(String(error)).toMatch(/wrapper.*hookwrapper.*mutually exclusive/);
    expect((error as PluginValidationError).plugin).toBe(plugin);
  });

  test("add tracefuncs", () => {
    const out: any[] = [];

    class api1 {
      he_method1(): void {
        out.push("he_method1-api1");
      }
    }
    hookimpl(api1.prototype.he_method1);

    class api2 {
      he_method1(): void {
        out.push("he_method1-api2");
      }
    }
    hookimpl(api2.prototype.he_method1);

    he_pm.register(new api1());
    he_pm.register(new api2());

    const before = (
      hook_name: string,
      hook_impls: unknown[],
      kwargs: Record<string, unknown>,
    ): void => {
      out.push([hook_name, [...hook_impls], kwargs]);
    };

    const after = (
      outcome: Result<unknown>,
      hook_name: string,
      hook_impls: unknown[],
      kwargs: Record<string, unknown>,
    ): void => {
      out.push([outcome, hook_name, [...hook_impls], kwargs]);
    };

    const undo = he_pm.add_hookcall_monitoring(before, after);

    he_pm.hook.he_method1({ arg: 1 });
    expect(out.length).toBe(4);
    expect(out[0][0]).toBe("he_method1");
    expect(out[0][1].length).toBe(2);
    expect(typeof out[0][2]).toBe("object");
    expect(out[1]).toBe("he_method1-api2");
    expect(out[2]).toBe("he_method1-api1");
    expect(out[3].length).toBe(4);
    expect(out[3][1]).toBe(out[0][0]);

    undo();
    he_pm.hook.he_method1({ arg: 1 });
    expect(out.length).toBe(4 + 2);
  });

  test("hook tracing", () => {
    class TestValueError extends Error {}

    const saveindent: number[] = [];

    class api1 {
      he_method1(): void {
        saveindent.push(he_pm.trace.root.indent);
      }
    }
    hookimpl(api1.prototype.he_method1);

    class api2 {
      he_method1(): void {
        saveindent.push(he_pm.trace.root.indent);
        throw new TestValueError();
      }
    }
    hookimpl(api2.prototype.he_method1);

    he_pm.register(new api1());
    const out: any[] = [];
    he_pm.trace.root.setwriter((arg) => out.push(arg));
    const undo = he_pm.enable_tracing();
    try {
      const indent = he_pm.trace.root.indent;
      he_pm.hook.he_method1({ arg: 1 });
      expect(indent).toBe(he_pm.trace.root.indent);
      expect(out.length).toBe(2);
      expect(out[0]).toContain("he_method1");
      expect(out[1]).toContain("finish");

      out.length = 0;
      he_pm.register(new api2());

      expect(() => he_pm.hook.he_method1({ arg: 1 })).toThrow(TestValueError);
      expect(he_pm.trace.root.indent).toBe(indent);
      expect(saveindent[0]).toBeGreaterThan(indent);
    } finally {
      undo();
    }
  });
});

test("pm name", () => {
  class A {}

  const a1 = new A();
  const name = pm.register(a1, "hello");
  expect(name).toBe("hello");
  pm.unregister(a1);
  expect(pm.get_plugin("hello")).toBeNull();
  expect(pm.is_registered(a1)).toBe(false);
  expect(pm.get_plugins().size).toBe(0);
  const name2 = pm.register(a1, "hello");
  expect(name2).toBe(name);
  pm.unregister(null, "hello");
  expect(pm.get_plugin("hello")).toBeNull();
  expect(pm.is_registered(a1)).toBe(false);
  expect(pm.get_plugins().size).toBe(0);
});

test("set blocked", () => {
  class A {}

  const a1 = new A();
  const name = pm.register(a1);
  expect(name).not.toBeNull();
  expect(pm.is_registered(a1)).toBe(true);
  expect(pm.is_blocked(name!)).toBe(false);
  expect(pm.get_plugins()).toEqual(new Set([a1]));

  pm.set_blocked(name!);
  expect(pm.is_blocked(name!)).toBe(true);
  expect(pm.is_registered(a1)).toBe(false);
  expect(pm.get_plugins()).toEqual(new Set());

  pm.set_blocked("somename");
  expect(pm.is_blocked("somename")).toBe(true);
  expect(pm.register(new A(), "somename")).toBeNull();
  pm.unregister(null, "somename");
  expect(pm.is_blocked("somename")).toBe(true);
  expect(pm.get_plugins()).toEqual(new Set());

  // Unblock.
  expect(pm.unblock("someothername")).toBe(false);
  expect(pm.unblock("somename")).toBe(true);
  expect(pm.is_blocked("somename")).toBe(false);
  expect(pm.unblock("somename")).toBe(false);
  expect(pm.register(new A(), "somename")).not.toBeNull();
});

test("register", () => {
  class MyPlugin {
    he_method1(): void {}
  }
  hookimpl(MyPlugin.prototype.he_method1);

  const my = new MyPlugin();
  pm.register(my);
  expect(pm.get_plugins()).toEqual(new Set([my]));
  const my2 = new MyPlugin();
  pm.register(my2);
  expect(pm.get_plugins()).toEqual(new Set([my, my2]));

  expect(pm.is_registered(my)).toBe(true);
  expect(pm.is_registered(my2)).toBe(true);
  pm.unregister(my);
  expect(pm.is_registered(my)).toBe(false);
  expect(pm.get_plugins()).toEqual(new Set([my2]));

  let error: unknown;
  try {
    pm.unregister(my);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AssertionError);
  expect(String(error)).toMatch(/not registered/);
});

test("unregister blocked", () => {
  class Plugin {}

  const p = new Plugin();
  pm.set_blocked("error");
  pm.register(p, "error");
  // blocked plugins can be unregistered many times atm
  pm.unregister(p, "error");
  pm.unregister(p, "error");
});

test("register unknown hooks", () => {
  class Plugin1 {
    he_method1(arg: number): number {
      return arg + 1;
    }
  }
  hookimpl(Plugin1.prototype.he_method1);

  const pname = pm.register(new Plugin1());
  expect(pname).not.toBeNull();

  const Hooks = {
    he_method1: hookspec(function he_method1(arg: unknown) {}),
  };

  pm.add_hookspecs(Hooks);
  expect(pm.hook.he_method1({ arg: 1 })).toEqual([2]);
  const hookcallers = pm.get_hookcallers(pm.get_plugin(pname!));
  expect(hookcallers).not.toBeNull();
  expect(hookcallers!.length).toBe(1);
});

test("register historic", () => {
  const Hooks = {
    he_method1: hookspec({ historic: true })(function he_method1(
      arg: unknown,
    ) {}),
  };

  pm.add_hookspecs(Hooks);

  pm.hook.he_method1.call_historic(null, { arg: 1 });
  const out: number[] = [];

  const plugin = {
    he_method1: hookimpl(function he_method1(arg: number) {
      out.push(arg);
    }),
  };

  pm.register(plugin);
  expect(out).toEqual([1]);

  const plugin2 = {
    he_method1: hookimpl(function he_method1(arg: number) {
      out.push(arg * 10);
    }),
  };

  pm.register(plugin2);
  expect(out).toEqual([1, 10]);
  pm.hook.he_method1.call_historic(null, { arg: 12 });
  expect(out).toEqual([1, 10, 120, 12]);
});

test("historic with subset hook caller", () => {
  const Hooks = {
    he_method1: hookspec({ historic: true })(function he_method1(
      arg: unknown,
    ) {}),
  };

  pm.add_hookspecs(Hooks);

  const out: number[] = [];

  const makePlugin = () => ({
    he_method1: hookimpl(function he_method1(arg: number) {
      out.push(arg);
    }),
  });
  const plugin = makePlugin();
  pm.register(plugin);

  const plugin2 = {
    he_method1: hookimpl(function he_method1(arg: number) {
      out.push(arg * 10);
    }),
  };

  const shc = pm.subset_hook_caller("he_method1", [plugin]);
  shc.call_historic(null, { arg: 1 });

  pm.register(plugin2);
  expect(out).toEqual([10]);

  pm.register(makePlugin());
  expect(out).toEqual([10, 1]);
});

describe.each([[true], [false]])(
  "with result memorized (result_callback=%s)",
  (result_callback) => {
    test("with result memorized", () => {
      // Verify that HookCaller._maybe_apply_history() correctly applies
      // the result_callback function, when provided, to the result from
      // calling each newly registered hook.
      const out: number[] = [];
      const callback = result_callback
        ? (res: number) => {
            out.push(res);
          }
        : null;

      const Hooks = {
        he_method1: hookspec({ historic: true })(function he_method1(
          arg: unknown,
        ) {}),
      };

      pm.add_hookspecs(Hooks);

      const plugin1 = {
        he_method1: hookimpl(function he_method1(arg: number) {
          return arg * 10;
        }),
      };

      pm.register(plugin1);

      const he_method1 = pm.hook.he_method1;
      he_method1.call_historic(callback, { arg: 1 });

      const plugin2 = {
        he_method1: hookimpl(function he_method1(arg: number) {
          return arg * 10;
        }),
      };

      pm.register(plugin2);
      if (result_callback) {
        expect(out).toEqual([10, 10]);
      } else {
        expect(out).toEqual([]);
      }
    });
  },
);

test("with callbacks immediately executed", () => {
  const Hooks = {
    he_method1: hookspec({ historic: true })(function he_method1(
      arg: unknown,
    ) {}),
  };

  pm.add_hookspecs(Hooks);

  const plugin1 = {
    he_method1: hookimpl(function he_method1(arg: number) {
      return arg * 10;
    }),
  };
  const plugin2 = {
    he_method1: hookimpl(function he_method1(arg: number) {
      return arg * 20;
    }),
  };
  const plugin3 = {
    he_method1: hookimpl(function he_method1(arg: number) {
      return arg * 30;
    }),
  };

  const out: number[] = [];
  pm.register(plugin1);
  pm.register(plugin2);

  const he_method1 = pm.hook.he_method1;
  he_method1.call_historic((res: number) => out.push(res), { arg: 1 });
  expect(out).toEqual([20, 10]);
  pm.register(plugin3);
  expect(out).toEqual([20, 10, 30]);
});

test("register historic incompat hookwrapper", () => {
  const Hooks = {
    he_method1: hookspec({ historic: true })(function he_method1(
      arg: unknown,
    ) {}),
  };

  pm.add_hookspecs(Hooks);

  const out: number[] = [];

  const plugin = {
    he_method1: hookimpl({ hookwrapper: true })(function* he_method1(
      arg: number,
    ) {
      out.push(arg);
      yield;
    }),
  };

  expect(() => pm.register(plugin)).toThrow(PluginValidationError);
});

test("register historic incompat wrapper", () => {
  const Hooks = {
    he_method1: hookspec({ historic: true })(function he_method1(
      arg: unknown,
    ) {}),
  };

  pm.add_hookspecs(Hooks);

  const plugin = {
    he_method1: hookimpl({ wrapper: true })(function* he_method1(arg: number) {
      yield;
    }),
  };

  expect(() => pm.register(plugin)).toThrow(PluginValidationError);
});

test("call extra", () => {
  const Hooks = {
    he_method1: hookspec(function he_method1(arg: unknown) {}),
  };

  pm.add_hookspecs(Hooks);

  function he_method1(arg: number): number {
    return arg * 10;
  }

  const out = pm.hook.he_method1.call_extra([he_method1], { arg: 1 });
  expect(out).toEqual([10]);
});

test("call with too few args", () => {
  class ZeroDivisionError extends Error {}

  const Hooks = {
    he_method1: hookspec(function he_method1(arg: unknown) {}),
  };

  pm.add_hookspecs(Hooks);

  const plugin1 = {
    he_method1: hookimpl(function he_method1(arg: unknown) {
      // Python: 0 / 0 raises ZeroDivisionError; JS needs an explicit throw.
      throw new ZeroDivisionError();
    }),
  };

  pm.register(plugin1);
  expect(() => pm.hook.he_method1({ arg: "works" })).toThrow(ZeroDivisionError);

  const { error, warnings } = recordWarnings(() => pm.hook.he_method1());
  expect(error).toBeInstanceOf(HookCallError);
  expect(warnings.some((w) => w instanceof UserWarning)).toBe(true);
});

test("subset hook caller", () => {
  const Hooks = {
    he_method1: hookspec(function he_method1(arg: unknown) {}),
  };

  pm.add_hookspecs(Hooks);

  const out: number[] = [];

  const plugin1 = {
    he_method1: hookimpl(function he_method1(arg: number) {
      out.push(arg);
    }),
  };
  const plugin2 = {
    he_method1: hookimpl(function he_method1(arg: number) {
      out.push(arg * 10);
    }),
  };
  const plugin3 = {};

  pm.register(plugin1);
  pm.register(plugin2);
  pm.register(plugin3);
  pm.hook.he_method1({ arg: 1 });
  expect(out).toEqual([10, 1]);
  out.length = 0;

  let hc = pm.subset_hook_caller("he_method1", [plugin1]);
  hc({ arg: 2 });
  expect(out).toEqual([20]);
  out.length = 0;

  hc = pm.subset_hook_caller("he_method1", [plugin2]);
  hc({ arg: 2 });
  expect(out).toEqual([2]);
  out.length = 0;

  pm.unregister(plugin1);
  hc({ arg: 2 });
  expect(out).toEqual([]);
  out.length = 0;

  pm.hook.he_method1({ arg: 1 });
  expect(out).toEqual([10]);

  expect(String(hc)).toBe("<_SubsetHookCaller 'he_method1'>");
});

test("get_hookimpls", () => {
  const Hooks = {
    he_method1: hookspec(function he_method1(arg: unknown) {}),
  };

  pm.add_hookspecs(Hooks);
  expect(pm.hook.he_method1.get_hookimpls()).toEqual([]);

  const plugin1 = {
    he_method1: hookimpl(function he_method1(arg: unknown) {}),
  };
  const plugin2 = {
    he_method1: hookimpl(function he_method1(arg: unknown) {}),
  };
  const plugin3 = {};

  pm.register(plugin1);
  pm.register(plugin2);
  pm.register(plugin3);

  const hookimpls = pm.hook.he_method1.get_hookimpls();
  const hook_plugins = hookimpls.map((item) => item.plugin);
  expect(hook_plugins).toEqual([plugin1, plugin2]);
  expect(hook_plugins[0]).toBe(plugin1);
  expect(hook_plugins[1]).toBe(plugin2);
});

test("get_hookcallers", () => {
  class Hooks {
    he_method1(): void {}
    he_method2(): void {}
  }
  hookspec(Hooks.prototype.he_method1);
  hookspec(Hooks.prototype.he_method2);

  pm.add_hookspecs(Hooks);

  class Plugin1 {
    he_method1(): void {}
    he_method2(): void {}
  }
  hookimpl(Plugin1.prototype.he_method1);
  hookimpl(Plugin1.prototype.he_method2);

  class Plugin2 {
    he_method1(): void {}
  }
  hookimpl(Plugin2.prototype.he_method1);

  class Plugin3 {
    he_method2(): void {}
  }
  hookimpl(Plugin3.prototype.he_method2);

  const plugin1 = new Plugin1();
  pm.register(plugin1);
  const plugin2 = new Plugin2();
  pm.register(plugin2);
  const plugin3 = new Plugin3();
  pm.register(plugin3);

  const hookcallers1 = pm.get_hookcallers(plugin1);
  expect(hookcallers1).not.toBeNull();
  expect(hookcallers1!.length).toBe(2);
  const hookcallers2 = pm.get_hookcallers(plugin2);
  expect(hookcallers2).not.toBeNull();
  expect(hookcallers2!.length).toBe(1);
  const hookcallers3 = pm.get_hookcallers(plugin3);
  expect(hookcallers3).not.toBeNull();
  expect(hookcallers3!.length).toBe(1);
  const combined = [...hookcallers2!, ...hookcallers3!];
  expect(hookcallers1!.length).toBe(combined.length);
  hookcallers1!.forEach((hc, i) => expect(hc).toBe(combined[i]));

  expect(pm.get_hookcallers({})).toBeNull();
});

test("add_hookspecs nohooks", () => {
  class NoHooks {}

  expect(() => pm.add_hookspecs(NoHooks)).toThrow(ValueError);
});

test("load setuptools instantiation", () => {
  class PseudoPlugin {
    x = 42;
  }

  const entryPoint = {
    name: "myname",
    group: "hello",
    value: "myname:foo",
    load: () => new PseudoPlugin(),
  };

  const dist = {
    entry_points: [entryPoint],
    metadata: { name: "distname" },
  };

  const restore = setDistributions(() => [dist]);
  try {
    let num = pm.load_setuptools_entrypoints("hello");
    expect(num).toBe(1);
    const plugin = pm.get_plugin("myname");
    expect(plugin).not.toBeNull();
    expect(plugin.x).toBe(42);
    const ret = pm.list_plugin_distinfo();
    expect(ret.length).toBe(1);
    expect(ret[0].length).toBe(2);
    expect(ret[0][0]).toBe(plugin);
    expect(ret[0][1]._dist).toBe(dist);
    num = pm.load_setuptools_entrypoints("hello");
    expect(num).toBe(0); // no plugin loaded by this call
  } finally {
    setDistributions(restore);
  }
});

describe.each([[false], [true]])(
  "register while calling (historic=%s)",
  (historic) => {
    test("register while calling", () => {
      // Test that registering an impl of a hook while it is being called
      // does not affect the call itself, only later calls.
      // For historic hooks however, the hook is called immediately on
      // registration. Regression test for #438.
      const testHookspec = new HookspecMarker("example");

      const Hooks = {
        configure: testHookspec({ historic })(function configure() {
          throw new Error("NotImplementedError");
        }),
      };

      class Plugin1 {
        configure(): number {
          return 1;
        }
      }
      hookimpl(Plugin1.prototype.configure);

      class Plugin4 {
        configure(): number {
          return 4;
        }
      }
      hookimpl({ tryfirst: true })(Plugin4.prototype.configure);

      class Plugin5 {
        configure(): number {
          return 5;
        }
      }
      hookimpl()(Plugin5.prototype.configure);

      class Plugin6 {
        configure(): number {
          return 6;
        }
      }
      hookimpl({ trylast: true })(Plugin6.prototype.configure);

      class Plugin2 {
        already_registered = false;

        configure(this: Plugin2): number {
          if (!this.already_registered) {
            pm.register(new Plugin4());
            pm.register(new Plugin5());
            pm.register(new Plugin6());
            this.already_registered = true;
          }
          return 2;
        }
      }
      hookimpl(Plugin2.prototype.configure);

      class Plugin3 {
        configure(): number {
          return 3;
        }
      }
      hookimpl(Plugin3.prototype.configure);

      pm.add_hookspecs(Hooks);
      pm.register(new Plugin1());
      pm.register(new Plugin2());
      pm.register(new Plugin3());

      if (!historic) {
        let result = pm.hook.configure();
        expect(result).toEqual([3, 2, 1]);
        result = pm.hook.configure();
        expect(result).toEqual([4, 5, 3, 2, 1, 6]);
      } else {
        let result: number[] = [];
        pm.hook.configure.call_historic((r: number) => result.push(r));
        expect(result).toEqual([4, 5, 6, 3, 2, 1]);
        result = [];
        pm.hook.configure.call_historic((r: number) => result.push(r));
        expect(result).toEqual([4, 5, 3, 2, 1, 6]);
      }
    });
  },
);

test("check_pending skips underscore", () => {
  const plugin = {
    _problem: hookimpl(function _problem() {}),
  };

  pm.register(plugin);
  pm.hook._problem();
  pm.check_pending();
});

test("check_pending optionalhook", () => {
  const plugin = {
    a_hook: hookimpl({ optionalhook: true })(function a_hook(param: unknown) {}),
  };

  pm.register(plugin);
  pm.hook.a_hook({ param: 1 });
  pm.check_pending();
});

test("check_pending nonspec hook", () => {
  const localHookimpl = new HookimplMarker("example");

  const plugin = {
    a_hook: localHookimpl(function a_hook(param: unknown) {}),
  };

  pm.register(plugin);
  expect(() => pm.hook.a_hook()).toThrow(
    /hook call must provide argument 'param'/,
  );

  expect(() => pm.check_pending()).toThrow(
    /unknown hook 'a_hook' in plugin .*/,
  );
});

test("unregister plugin with multi hookimpls", () => {
  // Verify that unregistering a plugin with multiple hookimpls on the same
  // hook (via specname) removes all of them (#431).
  const Api = {
    hello: hookspec(function hello(arg: unknown) {}),
  };

  pm.add_hookspecs(Api);

  const plugin = {
    hello: hookimpl(function hello(arg: number) {
      return arg + 1;
    }),
    hello_again: hookimpl({ specname: "hello" })(function hello_again(
      arg: number,
    ) {
      return arg + 100;
    }),
  };

  pm.register(plugin);

  // Both implementations should be registered.
  const impls = pm.hook.hello.get_hookimpls();
  expect(impls.length).toBe(2);

  // Both implementations should run.
  const out = pm.hook.hello({ arg: 3 }) as number[];
  expect([...out].sort((a, b) => a - b)).toEqual([4, 103]);

  // After unregister, no implementations should remain.
  pm.unregister(plugin);
  expect(pm.hook.hello({ arg: 3 })).toEqual([]);
  expect(pm.hook.hello.get_hookimpls()).toEqual([]);
});

test("get_hookcallers no duplicates", () => {
  // Verify that get_hookcallers does not return duplicate HookCaller
  // entries when a plugin has multiple hookimpls on the same hook (#431).
  const Api = {
    hello: hookspec(function hello(arg: unknown) {}),
    goodbye: hookspec(function goodbye(arg: unknown) {}),
  };

  pm.add_hookspecs(Api);

  const plugin = {
    hello: hookimpl(function hello(arg: number) {
      return arg + 1;
    }),
    hello_again: hookimpl({ specname: "hello" })(function hello_again(
      arg: number,
    ) {
      return arg + 100;
    }),
    goodbye: hookimpl(function goodbye(arg: number) {
      return arg + 200;
    }),
  };

  pm.register(plugin);

  const hookcallers = pm.get_hookcallers(plugin);
  expect(hookcallers).not.toBeNull();
  // Should return 2 unique callers (hello + goodbye), not 3.
  expect(hookcallers!.length).toBe(2);
  const caller_names = new Set(hookcallers!.map((hc) => hc.name));
  expect(caller_names).toEqual(new Set(["hello", "goodbye"]));
});
