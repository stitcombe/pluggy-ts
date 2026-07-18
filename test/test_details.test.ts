/** Port of testing/test_details.py. */

import { beforeEach, expect, test } from "vitest";
import {
  DeprecationWarning,
  DistFacade,
  HookCallError,
  HookimplMarker,
  HookspecMarker,
  PluginManager,
  UserWarning,
  ValueError,
} from "../src/index.js";
import { HookimplOpts, Plugin } from "../src/hooks.js";
import { makePm, expectWarns } from "./conftest.js";

const hookspec = new HookspecMarker("example");
const hookimpl = new HookimplMarker("example");

let pm: PluginManager;

beforeEach(() => {
  pm = makePm();
});

test("parse_hookimpl override", () => {
  class MyPluginManager extends PluginManager {
    parse_hookimpl_opts(
      module_or_class: Plugin,
      name: string,
    ): Partial<HookimplOpts> | null {
      let opts = super.parse_hookimpl_opts(module_or_class, name);
      if (opts === null) {
        if (name.startsWith("x1")) {
          opts = {};
        }
      }
      return opts;
    }
  }

  const plugin = {
    x1meth: function x1meth() {},
    x1meth2: hookimpl({ hookwrapper: true, tryfirst: true })(
      function* x1meth2() {
        yield;
      },
    ),
    x1meth3: hookimpl({ wrapper: true, trylast: true })(function* x1meth3(): Generator<
      undefined,
      any,
      any
    > {
      return yield;
    }),
  };

  const Spec = {
    x1meth: hookspec(function x1meth() {}),
    x1meth2: hookspec(function x1meth2() {}),
    x1meth3: hookspec(function x1meth3() {}),
  };

  const mypm = new MyPluginManager(hookspec.project_name);
  mypm.register(plugin);
  mypm.add_hookspecs(Spec);

  let hookimpls = mypm.hook.x1meth.get_hookimpls();
  expect(hookimpls.length).toBe(1);
  expect(hookimpls[0].hookwrapper).toBe(false);
  expect(hookimpls[0].wrapper).toBe(false);
  expect(hookimpls[0].tryfirst).toBe(false);
  expect(hookimpls[0].trylast).toBe(false);
  expect(hookimpls[0].optionalhook).toBe(false);

  hookimpls = mypm.hook.x1meth2.get_hookimpls();
  expect(hookimpls.length).toBe(1);
  expect(hookimpls[0].hookwrapper).toBe(true);
  expect(hookimpls[0].wrapper).toBe(false);
  expect(hookimpls[0].tryfirst).toBe(true);

  hookimpls = mypm.hook.x1meth3.get_hookimpls();
  expect(hookimpls.length).toBe(1);
  expect(hookimpls[0].hookwrapper).toBe(false);
  expect(hookimpls[0].wrapper).toBe(true);
  expect(hookimpls[0].tryfirst).toBe(false);
  expect(hookimpls[0].trylast).toBe(true);
});

test("warn when deprecated specified", () => {
  const warning = new DeprecationWarning("foo is deprecated");

  const Spec = {
    foo: hookspec({ warn_on_impl: warning })(function foo() {}),
  };

  const plugin = {
    foo: hookimpl(function foo() {}),
  };

  const localPm = new PluginManager(hookspec.project_name);
  localPm.add_hookspecs(Spec);

  const [, records] = expectWarns(DeprecationWarning, null, () =>
    localPm.register(plugin),
  );
  expect(records.length).toBe(1);
  // The warning instance itself is emitted. (Python also checks the
  // implementation's file/line, which JS functions do not expose.)
  expect(records[0]).toBe(warning);
});

test("warn when deprecated args specified", () => {
  const warning1 = new DeprecationWarning("old1 is deprecated");
  const warning2 = new DeprecationWarning("old2 is deprecated");

  const Spec = {
    foo: hookspec({
      warn_on_impl_args: {
        old1: warning1,
        old2: warning2,
      },
    })(function foo(old1: unknown, new_: unknown, old2: unknown) {
      throw new Error("NotImplementedError");
    }),
  };

  const plugin = {
    foo: hookimpl(function foo(old2: unknown, old1: unknown, new_: unknown) {
      throw new Error("NotImplementedError");
    }),
  };

  const localPm = new PluginManager(hookspec.project_name);
  localPm.add_hookspecs(Spec);

  const [, records] = expectWarns(DeprecationWarning, null, () =>
    localPm.register(plugin),
  );
  expect(records.length).toBe(2);
  // The impl requests old2 first, so its warning is emitted first.
  expect(records[0]).toBe(warning2);
  expect(records[1]).toBe(warning1);
});

test("plugin getattr raises errors", () => {
  // Pluggy must be able to handle plugins which raise weird exceptions
  // when getattr() gets called (#11).
  const dontTouchMe = new Proxy(
    {},
    {
      get() {
        throw new Error("can't touch me");
      },
    },
  );

  const module = { x: dontTouchMe };
  expect(() => (module.x as any).broken).toThrow(/touch me/);

  const localPm = new PluginManager(hookspec.project_name);
  // register() would raise an error
  localPm.register(module, "donttouch");
  expect(localPm.get_plugin("donttouch")).toBe(module);
});

test("not all arguments are provided issues a warning", () => {
  // Calling a hook without providing all arguments specified in the hook
  // spec issues a warning.
  const Spec = {
    hello: hookspec(function hello(arg1: unknown, arg2: unknown) {}),
    herstory: hookspec({ historic: true })(function herstory(
      arg1: unknown,
      arg2: unknown,
    ) {}),
  };

  pm.add_hookspecs(Spec);

  expectWarns(UserWarning, /'arg1', 'arg2'.*cannot be found/, () =>
    pm.hook.hello(),
  );
  expectWarns(UserWarning, /'arg2'.*cannot be found/, () =>
    pm.hook.hello({ arg1: 1 }),
  );
  expectWarns(UserWarning, /'arg1'.*cannot be found/, () =>
    pm.hook.hello({ arg2: 2 }),
  );

  expectWarns(UserWarning, /'arg1', 'arg2'.*cannot be found/, () =>
    pm.hook.hello.call_extra([], {}),
  );

  expectWarns(UserWarning, /'arg1', 'arg2'.*cannot be found/, () =>
    pm.hook.herstory.call_historic(null, {}),
  );
});

test("repr", () => {
  const plugin = {
    myhook: hookimpl(function myhook() {
      throw new Error("NotImplementedError");
    }),
  };

  const localPm = new PluginManager(hookspec.project_name);

  const pname = localPm.register(plugin);
  expect(String(localPm.hook.myhook.get_hookimpls()[0])).toBe(
    `<HookImpl plugin_name='${pname}', plugin=${String(plugin)}>`,
  );
});

test("dist facade list attributes", () => {
  const dist = {
    entry_points: [],
    metadata: { name: "pluggy" },
    version: "1.0.0",
    files: ["a.txt"],
  };
  const fc = new DistFacade(dist);
  // Attribute proxying to the underlying distribution.
  expect((fc as any).version).toBe("1.0.0");
  expect((fc as any).files).toEqual(["a.txt"]);
  expect(fc.project_name).toBe("pluggy");
  expect(fc._dist).toBe(dist);
  // The facade exposes _dist and project_name on top of the dist's own
  // attributes (Python asserts this via dir()).
  const res = Reflect.ownKeys(fc).filter(
    (k): k is string => typeof k === "string",
  );
  expect(res).toContain("_dist");
  expect(res).toContain("project_name");
  for (const key of Object.keys(dist)) {
    expect(res).toContain(key);
  }
});

test("hookimpl disallow invalid combination", () => {
  const decorator = hookspec({ historic: true, firstresult: true });
  expect(() => decorator(function any_() {})).toThrow(
    /cannot have a historic firstresult hook/,
  );
  expect(() => decorator(function any_() {})).toThrow(ValueError);
});

test("hook nonspec call", () => {
  const plugin = {
    a_hook: hookimpl(function a_hook(passed: string, missing: number) {}),
  };

  pm.register(plugin);
  expect(() => pm.hook.a_hook({ passed: "a" })).toThrow(
    /hook call must provide argument 'missing'/,
  );
  expect(() => pm.hook.a_hook({ passed: "a" })).toThrow(HookCallError);
  pm.hook.a_hook({ passed: "a", missing: "ok" });
});

test("wrapper runtimeerror passtrough", () => {
  // ensure runtime-error passes through a wrapper in case of exceptions
  class TestRuntimeError extends Error {}

  const fail = {
    fail_late: hookimpl(function fail_late() {
      throw new TestRuntimeError("this is personal");
    }),
  };

  const plugin = {
    fail_late: hookimpl({ wrapper: true })(function* fail_late() {
      yield;
    }),
  };

  pm.register(plugin);
  pm.register(fail);
  expect(() => pm.hook.fail_late()).toThrow(/this is personal/);
  expect(() => pm.hook.fail_late()).toThrow(TestRuntimeError);
});
