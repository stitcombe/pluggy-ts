/**
 * Port of testing/conftest.py plus pytest-emulation helpers shared by the
 * test files.
 */

import { expect } from "vitest";
import { HookspecMarker, PluginManager } from "../src/index.js";
import { addWarningHandler, Warning } from "../src/warnings.js";

/** The `pm` fixture. */
export function makePm(): PluginManager {
  return new PluginManager("example");
}

/**
 * The `he_pm` fixture. The Python fixture is parametrized over passing the
 * hookspec namespace as a class or an instance; `specForm` mirrors that.
 */
export type SpecForm = "spec-is-class" | "spec-is-instance";
export const SPEC_FORMS: SpecForm[] = ["spec-is-class", "spec-is-instance"];

export function makeHePm(pm: PluginManager, specForm: SpecForm): PluginManager {
  const hookspec = new HookspecMarker("example");

  class Hooks {
    he_method1(arg: number): number {
      return arg + 1;
    }
  }
  hookspec(Hooks.prototype.he_method1);

  pm.add_hookspecs(specForm === "spec-is-class" ? Hooks : new Hooks());
  return pm;
}

/**
 * Run `fn` recording all warnings it emits; a thrown error is captured
 * rather than propagated so the recorded warnings stay observable
 * (pytest.warns/pytest.raises can nest either way in the originals).
 */
export function recordWarnings<T>(fn: () => T): {
  result: T | undefined;
  error: unknown;
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  const unsubscribe = addWarningHandler((w) => warnings.push(w));
  try {
    const result = fn();
    return { result, error: undefined, warnings };
  } catch (error) {
    return { result: undefined, error, warnings };
  } finally {
    unsubscribe();
  }
}

/**
 * pytest.warns analog: assert `fn` emits at least one warning of the given
 * category (optionally matching `match`), re-raise any error, and return
 * [result, matching warnings].
 */
export function expectWarns<T>(
  category: abstract new (...args: any[]) => Warning,
  match: RegExp | null,
  fn: () => T,
): [T, Warning[]] {
  const { result, error, warnings } = recordWarnings(fn);
  if (error !== undefined) {
    throw error;
  }
  const found = warnings.filter(
    (w) => w instanceof category && (match === null || match.test(w.message)),
  );
  expect(
    found.length,
    `expected a ${category.name} warning matching ${match}; got: ` +
      warnings.map((w) => `${w.name}(${w.message})`).join(", "),
  ).toBeGreaterThan(0);
  return [result as T, found];
}

/** warnings.simplefilter("error") analog: fail if `fn` emits any warning. */
export function expectNoWarnings<T>(fn: () => T): T {
  const { result, error, warnings } = recordWarnings(fn);
  if (error !== undefined) {
    throw error;
  }
  expect(warnings).toEqual([]);
  return result as T;
}
