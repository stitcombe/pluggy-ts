/**
 * Port of testing/test_warnings.py.
 *
 * The hookspec-missing-`self` tests from the original file exercise
 * Python's implicit method receiver and have no JavaScript equivalent
 * (see PORTING_NOTES.md); the teardown warning test is ported fully.
 */

import { beforeEach, expect, test } from "vitest";
import {
  HookimplMarker,
  HookspecMarker,
  PluggyTeardownRaisedWarning,
  PluginManager,
} from "../src/index.js";
import { makePm, expectNoWarnings, recordWarnings } from "./conftest.js";

const hookspec = new HookspecMarker("example");
const hookimpl = new HookimplMarker("example");

let pm: PluginManager;

beforeEach(() => {
  pm = makePm();
});

test("teardown raised warning", () => {
  class ZeroDivisionError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "ZeroDivisionError";
    }
  }

  const Api = {
    my_hook: hookspec(function my_hook() {
      throw new Error("NotImplementedError");
    }),
  };

  pm.add_hookspecs(Api);

  const plugin1 = {
    my_hook: hookimpl(function my_hook() {}),
  };

  const plugin2 = {
    my_hook: hookimpl({ hookwrapper: true })(function* my_hook() {
      yield;
      throw new ZeroDivisionError("division by zero");
    }),
  };

  const plugin3 = {
    my_hook: hookimpl({ hookwrapper: true })(function* my_hook() {
      yield;
    }),
  };

  pm.register(plugin1, "plugin1");
  pm.register(plugin2, "plugin2");
  pm.register(plugin3, "plugin3");

  const { error, warnings } = recordWarnings(() => pm.hook.my_hook());
  expect(error).toBeInstanceOf(ZeroDivisionError);
  const teardownWarnings = warnings.filter(
    (w) => w instanceof PluggyTeardownRaisedWarning,
  );
  expect(teardownWarnings.length).toBe(1);
  expect(teardownWarnings[0].message).toMatch(
    /\bplugin2\b.*\bmy_hook\b[\s\S]*ZeroDivisionError/,
  );
  // Python additionally asserts the warning points at the test file;
  // JS warnings carry no filename/lineno.
});

test("hookspec no self-equivalent has no warning", () => {
  // Python: a hookspec method without `self` emits a DeprecationWarning
  // (and versions with `self` or @staticmethod do not). JS methods have no
  // implicit receiver, so the only portable behavior is that adding a
  // normal hookspec never warns.
  class Api {
    my_hook(item: unknown, extra: unknown): void {}
  }
  hookspec(Api.prototype.my_hook);

  expectNoWarnings(() => pm.add_hookspecs(Api));
});
