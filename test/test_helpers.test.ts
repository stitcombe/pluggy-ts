/**
 * Port of testing/test_helpers.py.
 *
 * The Python original exercises CPython introspection details — implicit
 * `self`/`cls` stripping, bound vs unbound methods, keyword-only args,
 * `@classmethod`/`@staticmethod`, string annotations. None of those exist
 * in JavaScript, so those tests are represented here by their closest
 * meaningful equivalent (see PORTING_NOTES.md). The core contract is
 * identical: varnames returns [required params, defaulted params].
 */

import { expect, test } from "vitest";
import { varnames } from "../src/hooks.js";
import { _formatdef } from "../src/manager.js";

test("varnames", () => {
  function f(x: number): void {
    void x;
  }

  class A {
    f(y: number): void {
      void y;
    }
  }

  // Python's callable object with __call__; supported via the __call__
  // convention.
  const b = {
    __call__: function (z: number): void {
      void z;
    },
  };

  expect(varnames(f)).toEqual([["x"], []]);
  expect(varnames(new A().f)).toEqual([["y"], []]);
  expect(varnames(A.prototype.f)).toEqual([["y"], []]);
  expect(varnames(b)).toEqual([["z"], []]);
});

test("varnames default", () => {
  function f(x: number, y = 3): void {
    void x;
    void y;
  }

  expect(varnames(f)).toEqual([["x"], ["y"]]);
});

test("varnames class", () => {
  class C {
    constructor(x: number) {
      void x;
    }
  }

  class D {}

  class E {
    constructor(x: number) {
      void x;
    }
  }

  class F {}

  expect(varnames(C)).toEqual([["x"], []]);
  expect(varnames(D)).toEqual([[], []]);
  expect(varnames(E)).toEqual([["x"], []]);
  expect(varnames(F)).toEqual([[], []]);
});

test("varnames rest params", () => {
  // JS has no keyword-only parameters; rest parameters are the closest
  // analog to Python's *args and are likewise excluded.
  function f1(x: number, ...rest: number[]): void {
    void x;
    void rest;
  }

  function f2(x: number, y = 3, ...rest: number[]): void {
    void x;
    void y;
    void rest;
  }

  expect(varnames(f1)).toEqual([["x"], []]);
  expect(varnames(f2)).toEqual([["x"], ["y"]]);
});

test("varnames arrow functions", () => {
  const f1 = (x: number, y: number): number => x + y;
  const f2 = (x: number): number => x;

  expect(varnames(f1)).toEqual([["x", "y"], []]);
  expect(varnames(f2)).toEqual([["x"], []]);
});

test("varnames complex defaults", () => {
  // Defaults containing commas, calls and strings must not confuse the
  // parameter parser.
  function helper(a: number, b: number): number {
    return a + b;
  }
  function f(
    x: number,
    y = helper(1, 2),
    z = "a, tricky ( string",
  ): void {
    void x;
    void y;
    void z;
  }

  expect(varnames(f)).toEqual([["x"], ["y", "z"]]);
});

test("formatdef", () => {
  function function1(): void {}

  expect(_formatdef(function1)).toBe("function1()");

  function function2(arg1: unknown): void {
    void arg1;
  }

  expect(_formatdef(function2)).toBe("function2(arg1)");

  function function3(arg1: unknown, arg2 = "qwe"): void {
    void arg1;
    void arg2;
  }

  expect(_formatdef(function3)).toBe('function3(arg1, arg2 = "qwe")');

  function function4(arg1: unknown, ...args: unknown[]): void {
    void arg1;
    void args;
  }

  expect(_formatdef(function4)).toBe("function4(arg1, ...args)");
});

test("varnames decorator", () => {
  // functools.wraps analog: a wrapper that records the wrapped function
  // under __wrapped__ so introspection sees the original signature.
  function my_decorator<F extends (...args: any[]) => any>(func: F): F {
    const wrapper = function (this: unknown, ...args: unknown[]) {
      return func.apply(this, args);
    };
    (wrapper as any).__wrapped__ = func;
    return wrapper as unknown as F;
  }

  const example = my_decorator(function example(a: number, b = 123): void {
    void a;
    void b;
  });

  class Example {
    example_method = my_decorator(function example_method(
      x: number,
      y = 1,
    ): void {
      void x;
      void y;
    });
  }

  const ex_inst = new Example();

  expect(varnames(example)).toEqual([["a"], ["b"]]);
  expect(varnames(ex_inst.example_method)).toEqual([["x"], ["y"]]);
});

test("varnames method from module function", () => {
  // A standalone function assigned as a class member parses the same way
  // when accessed on an instance. (Python's bound-method self-stripping
  // has no JS analog — there is no implicit first parameter.)
  function standalone(x: number): void {
    void x;
  }

  class MyClass {
    method = standalone;
  }

  expect(varnames(new MyClass().method)).toEqual([["x"], []]);
});

test("varnames static method", () => {
  class MyClass {
    static sm(x: number, y = 1): void {
      void x;
      void y;
    }
  }

  expect(varnames(MyClass.sm)).toEqual([["x"], ["y"]]);
});

test("varnames non-callable", () => {
  expect(varnames(42)).toEqual([[], []]);
  expect(varnames(null)).toEqual([[], []]);
  expect(varnames({})).toEqual([[], []]);
});
