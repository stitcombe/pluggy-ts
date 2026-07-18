/**
 * Internal hook annotation, representation and calling machinery.
 * Port of pluggy/_hooks.py.
 *
 * Differences from the Python original, forced by the language:
 *
 * - Hook calls take a single "kwargs" object instead of Python keyword
 *   arguments: `pm.hook.myhook({arg: 1})`.
 * - `varnames()` obtains parameter names by parsing `Function.toString()`
 *   instead of code-object introspection. JavaScript functions have no
 *   implicit `self`, so the self/cls stripping logic has no equivalent.
 * - Markers attach their options as a property on the function object
 *   (`<project_name>_impl` / `<project_name>_spec`), same as Python.
 * - `HookCaller` instances are directly callable (the constructor returns a
 *   function whose prototype is the class prototype), preserving the
 *   `pm.hook.name(kwargs)` calling convention.
 */

import { assert_, ValueError } from "./errors.js";
import { warn, UserWarning, Warning } from "./warnings.js";

export type AnyFunction = (...args: any[]) => any;
export type Namespace = object | AnyFunction;
export type Plugin = any;
export type HookExec = (
  hook_name: string,
  hook_impls: HookImpl[],
  caller_kwargs: Record<string, unknown>,
  firstresult: boolean,
) => unknown;
export type HookImplFunction = AnyFunction;

/** Options for a hook specification. */
export interface HookspecOpts {
  /** Whether the hook is first-result-only. */
  firstresult: boolean;
  /** Whether the hook is historic. */
  historic: boolean;
  /** Whether the hook warns when implemented. */
  warn_on_impl: Warning | null;
  /** Whether the hook warns when certain arguments are requested. */
  warn_on_impl_args: Record<string, Warning> | null;
}

/** Options for a hook implementation. */
export interface HookimplOpts {
  /** Whether the hook implementation is a (new-style) wrapper. */
  wrapper: boolean;
  /** Whether the hook implementation is an old-style wrapper. */
  hookwrapper: boolean;
  /** Whether validation against a hook specification is optional. */
  optionalhook: boolean;
  /** Whether to try to order this hook implementation first. */
  tryfirst: boolean;
  /** Whether to try to order this hook implementation last. */
  trylast: boolean;
  /** The name of the hook specification to match. */
  specname: string | null;
}

// ---------------------------------------------------------------------------
// Attribute access helpers (getattr()/dir() analogs)
// ---------------------------------------------------------------------------

/**
 * getattr() analog. For classes, falls back to prototype methods so that
 * `getAttr(Cls, "method")` finds instance methods like Python's unbound
 * `getattr(cls, name)` does.
 */
export function getAttr(obj: any, name: string): any {
  if (obj == null) {
    return undefined;
  }
  let value: unknown;
  try {
    value = obj[name];
  } catch {
    return undefined;
  }
  if (value === undefined && typeof obj === "function" && obj.prototype) {
    try {
      value = obj.prototype[name];
    } catch {
      return undefined;
    }
  }
  return value;
}

export function hasAttr(obj: any, name: string): boolean {
  return getAttr(obj, name) !== undefined;
}

const STOP_PROTOS = new Set<object>([
  Object.prototype,
  Function.prototype,
]);

function collectOwn(obj: object, names: Set<string>): void {
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(obj);
  } catch {
    return;
  }
  for (const key of keys) {
    names.add(key);
  }
}

/**
 * dir() analog: enumerate the attribute names of an object. For a class,
 * this includes static properties and prototype (instance) methods; for an
 * instance, own properties plus everything on the prototype chain short of
 * the built-in prototypes. Sorted, like Python's dir().
 */
export function dirObject(obj: unknown): string[] {
  if (obj == null) {
    return [];
  }
  const names = new Set<string>();
  if (typeof obj === "function") {
    collectOwn(obj, names);
    // Class methods live on .prototype.
    const proto = (obj as AnyFunction).prototype;
    if (proto && typeof proto === "object") {
      let cur: object | null = proto;
      while (cur && !STOP_PROTOS.has(cur)) {
        collectOwn(cur, names);
        cur = Object.getPrototypeOf(cur);
      }
    }
    // Function own-property noise that can never be a hook.
    names.delete("length");
    names.delete("name");
    names.delete("prototype");
    names.delete("arguments");
    names.delete("caller");
  } else if (typeof obj === "object") {
    let cur: object | null = obj;
    while (cur && !STOP_PROTOS.has(cur)) {
      collectOwn(cur, names);
      cur = Object.getPrototypeOf(cur);
    }
  } else {
    // Primitives have no interesting attributes.
    return [];
  }
  names.delete("constructor");
  return [...names].sort();
}

/** Python-style repr for error/format messages. */
export function repr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export interface HookspecMarkerOptions {
  firstresult?: boolean;
  historic?: boolean;
  warn_on_impl?: Warning | null;
  warn_on_impl_args?: Record<string, Warning> | null;
}

export interface HookspecMarker {
  <F extends AnyFunction>(func: F): F;
  (opts?: HookspecMarkerOptions): <F extends AnyFunction>(func: F) => F;
}

/**
 * Decorator/marker for functions that are hook specifications.
 *
 * Instantiate it with a project_name to get a marker. Calling
 * `PluginManager.add_hookspecs` later will discover all marked functions
 * if the PluginManager uses the same project name.
 */
export class HookspecMarker {
  declare project_name: string;

  constructor(project_name: string) {
    const setattr_hookspec_opts = <F extends AnyFunction>(
      func: F,
      o: HookspecMarkerOptions,
    ): F => {
      if (o.historic && o.firstresult) {
        throw new ValueError("cannot have a historic firstresult hook");
      }
      const opts: HookspecOpts = {
        firstresult: o.firstresult ?? false,
        historic: o.historic ?? false,
        warn_on_impl: o.warn_on_impl ?? null,
        warn_on_impl_args: o.warn_on_impl_args ?? null,
      };
      (func as any)[project_name + "_spec"] = opts;
      return func;
    };

    const self = ((funcOrOpts?: AnyFunction | HookspecMarkerOptions): any => {
      if (typeof funcOrOpts === "function") {
        return setattr_hookspec_opts(funcOrOpts, {});
      }
      const opts = funcOrOpts ?? {};
      return (func: AnyFunction) => setattr_hookspec_opts(func, opts);
    }) as unknown as HookspecMarker;
    Object.setPrototypeOf(self, new.target.prototype);
    self.project_name = project_name;
    return self;
  }
}

export interface HookimplMarkerOptions {
  wrapper?: boolean;
  hookwrapper?: boolean;
  optionalhook?: boolean;
  tryfirst?: boolean;
  trylast?: boolean;
  specname?: string | null;
}

export interface HookimplMarker {
  <F extends AnyFunction>(func: F): F;
  (opts?: HookimplMarkerOptions): <F extends AnyFunction>(func: F) => F;
}

/**
 * Decorator/marker for functions that are hook implementations.
 *
 * Instantiate it with a project_name to get a marker. Calling
 * `PluginManager.register` later will discover all marked functions if the
 * PluginManager uses the same project name.
 */
export class HookimplMarker {
  declare project_name: string;

  constructor(project_name: string) {
    const setattr_hookimpl_opts = <F extends AnyFunction>(
      func: F,
      o: HookimplMarkerOptions,
    ): F => {
      const opts: HookimplOpts = {
        wrapper: o.wrapper ?? false,
        hookwrapper: o.hookwrapper ?? false,
        optionalhook: o.optionalhook ?? false,
        tryfirst: o.tryfirst ?? false,
        trylast: o.trylast ?? false,
        specname: o.specname ?? null,
      };
      (func as any)[project_name + "_impl"] = opts;
      return func;
    };

    const self = ((funcOrOpts?: AnyFunction | HookimplMarkerOptions): any => {
      if (typeof funcOrOpts === "function") {
        return setattr_hookimpl_opts(funcOrOpts, {});
      }
      const opts = funcOrOpts ?? {};
      return (func: AnyFunction) => setattr_hookimpl_opts(func, opts);
    }) as unknown as HookimplMarker;
    Object.setPrototypeOf(self, new.target.prototype);
    self.project_name = project_name;
    return self;
  }
}

export function normalize_hookimpl_opts(opts: Partial<HookimplOpts>): void {
  opts.tryfirst ??= false;
  opts.trylast ??= false;
  opts.wrapper ??= false;
  opts.hookwrapper ??= false;
  opts.optionalhook ??= false;
  opts.specname ??= null;
}

// ---------------------------------------------------------------------------
// varnames: parameter-name introspection via Function.toString()
// ---------------------------------------------------------------------------

function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
    } else if (c === quote) {
      return i;
    }
  }
  return source.length - 1;
}

/** Return the parameter list text between the balanced parens at openIndex. */
function balancedParenContents(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i);
    } else if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return source.slice(openIndex + 1, i);
      }
    }
  }
  return "";
}

/** Split parameter-list text on top-level commas. */
function splitTopLevel(paramText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < paramText.length; i++) {
    const c = paramText[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(paramText, i);
      cur += paramText.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) {
    parts.push(cur);
  }
  return parts;
}

function topLevelIndexOfEquals(part: string): number {
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(part, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && depth === 0 && part[i + 1] !== "=" && part[i - 1] !== "=" && part[i + 1] !== ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Return the raw source text of each parameter of `func` (top-level-comma
 * separated, trimmed). Used by varnames() and _formatdef().
 */
export function parseParamSource(func: AnyFunction): string[] {
  let source: string;
  try {
    source = Function.prototype.toString.call(func);
  } catch {
    return [];
  }
  if (source.includes("[native code]")) {
    return [];
  }
  const trimmed = source.trim();

  if (/^class[\s{]/.test(trimmed)) {
    const m = /(?:^|[\s;{}])constructor\s*\(/.exec(trimmed);
    if (!m) {
      return [];
    }
    const openIndex = m.index + m[0].length - 1;
    return splitTopLevel(balancedParenContents(trimmed, openIndex)).map((p) =>
      p.trim(),
    );
  }

  // Single-parameter arrow function without parentheses: `x => ...`
  const arrow = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(trimmed);
  if (arrow) {
    return [arrow[1]];
  }

  const openIndex = trimmed.indexOf("(");
  if (openIndex === -1) {
    return [];
  }
  return splitTopLevel(balancedParenContents(trimmed, openIndex)).map((p) =>
    p.trim(),
  );
}

/**
 * Return [positional, defaulted] parameter names for a callable.
 *
 * In case of a class, its constructor parameters are considered. Objects
 * with a `__call__` function attribute are treated as callables. Rest
 * parameters (`...args`) and destructuring patterns are not included.
 * Functions carrying a `__wrapped__` chain (the functools.wraps convention)
 * are unwrapped first.
 *
 * Unlike Python there is no implicit `self`/`cls` first parameter in
 * JavaScript, so no stripping is performed.
 */
export function varnames(func: unknown): [string[], string[]] {
  let fn: AnyFunction;
  if (typeof func === "function") {
    fn = func as AnyFunction;
  } else if (
    func != null &&
    typeof (func as any).__call__ === "function"
  ) {
    fn = (func as any).__call__;
  } else {
    return [[], []];
  }

  while (typeof (fn as any).__wrapped__ === "function") {
    fn = (fn as any).__wrapped__;
  }

  const parts = parseParamSource(fn);
  const args: string[] = [];
  const kwargs: string[] = [];
  for (const part of parts) {
    if (!part || part.startsWith("...")) {
      continue;
    }
    const eq = topLevelIndexOfEquals(part);
    if (eq !== -1) {
      const name = part.slice(0, eq).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        kwargs.push(name);
      }
    } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
      args.push(part);
    }
    // Anything else (destructuring, etc.) has no Python analog; skip it.
  }
  return [args, kwargs];
}

export function isGeneratorFunction(fn: unknown): boolean {
  const tag = Object.prototype.toString.call(fn);
  return tag === "[object GeneratorFunction]" || tag === "[object AsyncGeneratorFunction]";
}

// ---------------------------------------------------------------------------
// HookRelay
// ---------------------------------------------------------------------------

/**
 * Hook holder object for performing 1:N hook calls where N is the number of
 * registered plugins. A plain string-keyed record of HookCaller instances.
 */
export type HookRelay = Record<string, HookCaller>;

export function makeHookRelay(): HookRelay {
  return {};
}

// Historical name (pluggy<=1.2), kept for backward compatibility.
export type _HookRelay = HookRelay;

export type CallHistory = Array<
  [Record<string, unknown>, ((result: any) => void) | null]
>;

// ---------------------------------------------------------------------------
// HookCaller
// ---------------------------------------------------------------------------

export interface HookCaller {
  /**
   * Call the hook. Only accepts a single object of keyword arguments, which
   * should match the hook specification. Returns the result(s) of calling
   * all registered plugins.
   */
  (kwargs?: Record<string, unknown>): any;
}

/** A caller of all registered implementations of a hook specification. */
export class HookCaller {
  /** Name of the hook getting called. */
  declare name: string;
  declare spec: HookSpec | null;
  declare _hookexec: HookExec;
  // The hookimpls list. The caller iterates it *in reverse*. Format:
  // 1. trylast nonwrappers
  // 2. nonwrappers
  // 3. tryfirst nonwrappers
  // 4. trylast wrappers
  // 5. wrappers
  // 6. tryfirst wrappers
  declare _hookimpls: HookImpl[];
  declare _call_history: CallHistory | null;

  constructor(
    name: string,
    hook_execute: HookExec,
    specmodule_or_class?: Namespace | null,
    spec_opts?: HookspecOpts | null,
  ) {
    const self = ((kwargs?: Record<string, unknown>, ...extra: unknown[]): any =>
      self._docall(kwargs, extra)) as unknown as HookCaller;
    Object.setPrototypeOf(self, new.target.prototype);
    // Function instances have a non-writable own `name`; redefine it.
    Object.defineProperty(self, "name", {
      value: name,
      writable: true,
      configurable: true,
    });
    self._hookexec = hook_execute;
    self._hookimpls = [];
    self._call_history = null;
    self.spec = null;
    if (specmodule_or_class != null) {
      assert_(spec_opts != null);
      self.set_specification(specmodule_or_class, spec_opts);
    }
    return self;
  }

  has_spec(): boolean {
    return this.spec !== null;
  }

  set_specification(
    specmodule_or_class: Namespace,
    spec_opts: HookspecOpts,
  ): void {
    if (this.spec !== null) {
      throw new ValueError(
        `Hook ${repr(this.spec.name)} is already registered ` +
          `within namespace ${namespaceRepr(this.spec.namespace)}`,
      );
    }
    this.spec = new HookSpec(specmodule_or_class, this.name, spec_opts);
    if (spec_opts.historic) {
      this._call_history = [];
    }
  }

  /** Whether this caller is historic. */
  is_historic(): boolean {
    return this._call_history !== null;
  }

  /** Remove all hook implementations registered by the given plugin. */
  _remove_plugin(plugin: Plugin): void {
    const remaining = this._hookimpls.filter((impl) => impl.plugin !== plugin);
    if (remaining.length === this._hookimpls.length) {
      throw new ValueError(`plugin ${plugin} not found`);
    }
    this._hookimpls.splice(0, this._hookimpls.length, ...remaining);
  }

  /** Get all registered hook implementations for this hook. */
  get_hookimpls(): HookImpl[] {
    return [...this._hookimpls];
  }

  /** Add an implementation to the callback chain. */
  _add_hookimpl(hookimpl: HookImpl): void {
    let splitpoint = this._hookimpls.length;
    for (let i = 0; i < this._hookimpls.length; i++) {
      const method = this._hookimpls[i];
      if (method.hookwrapper || method.wrapper) {
        splitpoint = i;
        break;
      }
    }
    let start: number;
    let end: number;
    if (hookimpl.hookwrapper || hookimpl.wrapper) {
      start = splitpoint;
      end = this._hookimpls.length;
    } else {
      start = 0;
      end = splitpoint;
    }

    if (hookimpl.trylast) {
      this._hookimpls.splice(start, 0, hookimpl);
    } else if (hookimpl.tryfirst) {
      this._hookimpls.splice(end, 0, hookimpl);
    } else {
      // find last non-tryfirst method
      let i = end - 1;
      while (i >= start && this._hookimpls[i].tryfirst) {
        i -= 1;
      }
      this._hookimpls.splice(i + 1, 0, hookimpl);
    }
  }

  toString(): string {
    return `<HookCaller ${repr(this.name)}>`;
  }

  _verify_all_args_are_provided(kwargs: Record<string, unknown>): void {
    // This is written to avoid expensive operations when not needed.
    if (this.spec) {
      for (const argname of this.spec.argnames) {
        if (!(argname in kwargs)) {
          const notincall = this.spec.argnames
            .filter((a) => !(a in kwargs))
            .map((a) => repr(a))
            .join(", ");
          warn(
            `Argument(s) ${notincall} which are declared in the hookspec ` +
              "cannot be found in this hook call",
            UserWarning,
          );
          break;
        }
      }
    }
  }

  _docall(kwargs: Record<string, unknown> | undefined, extra: unknown[]): any {
    if (
      extra.length > 0 ||
      (kwargs !== undefined &&
        (typeof kwargs !== "object" || kwargs === null || Array.isArray(kwargs)))
    ) {
      throw new TypeError(
        "__call__() takes 1 positional argument but 2 were given: hook " +
          "callers accept a single keyword-arguments object",
      );
    }
    const kw = kwargs ?? {};
    assert_(
      !this.is_historic(),
      "Cannot directly call a historic hook - use call_historic instead.",
    );
    this._verify_all_args_are_provided(kw);
    const firstresult = this.spec ? this.spec.opts.firstresult : false;
    // Copy because plugins may register other plugins during iteration (#438).
    return this._hookexec(this.name, [...this._hookimpls], kw, firstresult);
  }

  /**
   * Call the hook with given kwargs for all registered plugins and for all
   * plugins which will be registered afterwards.
   */
  call_historic(
    result_callback?: ((result: any) => void) | null,
    kwargs?: Record<string, unknown> | null,
  ): void {
    assert_(this._call_history !== null);
    const kw = kwargs ?? {};
    this._verify_all_args_are_provided(kw);
    this._call_history.push([kw, result_callback ?? null]);
    // Historizing hooks don't return results.
    // Remember firstresult isn't compatible with historic.
    // Copy because plugins may register other plugins during iteration (#438).
    const res = this._hookexec(this.name, [...this._hookimpls], kw, false);
    if (result_callback == null) {
      return;
    }
    if (Array.isArray(res)) {
      for (const x of res) {
        result_callback(x);
      }
    }
  }

  /**
   * Call the hook with some additional temporarily participating methods
   * using the specified kwargs as call parameters.
   */
  call_extra(
    methods: AnyFunction[],
    kwargs: Record<string, unknown>,
  ): any {
    assert_(
      !this.is_historic(),
      "Cannot directly call a historic hook - use call_historic instead.",
    );
    this._verify_all_args_are_provided(kwargs);
    const opts: HookimplOpts = {
      wrapper: false,
      hookwrapper: false,
      optionalhook: false,
      trylast: false,
      tryfirst: false,
      specname: null,
    };
    const hookimpls = [...this._hookimpls];
    for (const method of methods) {
      const hookimpl = new HookImpl(null, "<temp>", method, opts);
      // Find last non-tryfirst nonwrapper method.
      let i = hookimpls.length - 1;
      while (
        i >= 0 &&
        // Skip wrappers.
        (hookimpls[i].hookwrapper ||
          hookimpls[i].wrapper ||
          // Skip tryfirst nonwrappers.
          hookimpls[i].tryfirst)
      ) {
        i -= 1;
      }
      hookimpls.splice(i + 1, 0, hookimpl);
    }
    const firstresult = this.spec ? this.spec.opts.firstresult : false;
    return this._hookexec(this.name, hookimpls, kwargs, firstresult);
  }

  /** Apply call history to a new hookimpl if it is marked as historic. */
  _maybe_apply_history(method: HookImpl): void {
    if (this.is_historic()) {
      assert_(this._call_history !== null);
      for (const [kwargs, result_callback] of this._call_history) {
        const res = this._hookexec(this.name, [method], kwargs, false);
        if (Array.isArray(res) && res.length && result_callback !== null) {
          // XXX: remember firstresult isn't compat with historic
          result_callback(res[0]);
        }
      }
    }
  }
}

// Historical name (pluggy<=1.2), kept for backward compatibility.
export const _HookCaller = HookCaller;

function namespaceRepr(namespace: Namespace): string {
  if (typeof namespace === "function") {
    return `<class '${namespace.name}'>`;
  }
  return String(namespace);
}

/**
 * A proxy to another HookCaller which manages calls to all registered
 * plugins except the ones from remove_plugins.
 *
 * All *code* runs in the inherited class, but the underlying *data* is
 * delegated to the original HookCaller via accessor properties defined on
 * the instance.
 */
export class _SubsetHookCaller extends HookCaller {
  declare _orig: HookCaller;
  declare _remove_plugins: Set<Plugin>;

  constructor(orig: HookCaller, remove_plugins: Set<Plugin>) {
    super(orig.name, orig._hookexec);
    this._orig = orig;
    this._remove_plugins = remove_plugins;
    Object.defineProperty(this, "_hookimpls", {
      configurable: true,
      get: () =>
        orig._hookimpls.filter((impl) => !remove_plugins.has(impl.plugin)),
    });
    Object.defineProperty(this, "spec", {
      configurable: true,
      get: () => orig.spec,
    });
    Object.defineProperty(this, "_call_history", {
      configurable: true,
      get: () => orig._call_history,
    });
  }

  toString(): string {
    return `<_SubsetHookCaller ${repr(this.name)}>`;
  }
}

// ---------------------------------------------------------------------------
// HookImpl and HookSpec
// ---------------------------------------------------------------------------

/** A hook implementation in a HookCaller. */
export class HookImpl {
  /** The hook implementation function. */
  function: HookImplFunction;
  /** The positional parameter names of `function`. */
  argnames: string[];
  /** The defaulted parameter names of `function`. */
  kwargnames: string[];
  /** The plugin which defined this hook implementation. */
  plugin: Plugin;
  /** The HookimplOpts used to configure this hook implementation. */
  opts: HookimplOpts;
  /** The name of the plugin which defined this hook implementation. */
  plugin_name: string;
  /** Whether the hook implementation is a (new-style) wrapper. */
  wrapper: boolean;
  /** Whether the hook implementation is an old-style wrapper. */
  hookwrapper: boolean;
  /** Whether validation against a hook specification is optional. */
  optionalhook: boolean;
  /** Whether to try to order this hook implementation first. */
  tryfirst: boolean;
  /** Whether to try to order this hook implementation last. */
  trylast: boolean;

  constructor(
    plugin: Plugin,
    plugin_name: string,
    function_: HookImplFunction,
    hook_impl_opts: HookimplOpts,
  ) {
    this.function = function_;
    const [argnames, kwargnames] = varnames(this.function);
    this.argnames = argnames;
    this.kwargnames = kwargnames;
    this.plugin = plugin;
    this.opts = hook_impl_opts;
    this.plugin_name = plugin_name;
    this.wrapper = hook_impl_opts.wrapper;
    this.hookwrapper = hook_impl_opts.hookwrapper;
    this.optionalhook = hook_impl_opts.optionalhook;
    this.tryfirst = hook_impl_opts.tryfirst;
    this.trylast = hook_impl_opts.trylast;
  }

  toString(): string {
    return `<HookImpl plugin_name=${repr(this.plugin_name)}, plugin=${String(
      this.plugin,
    )}>`;
  }
}

export class HookSpec {
  namespace: Namespace;
  function: AnyFunction;
  name: string;
  argnames: string[];
  kwargnames: string[];
  opts: HookspecOpts;
  warn_on_impl: Warning | null;
  warn_on_impl_args: Record<string, Warning> | null;

  constructor(namespace: Namespace, name: string, opts: HookspecOpts) {
    this.namespace = namespace;
    this.name = name;
    this.function = getAttr(namespace, name);
    const [argnames, kwargnames] = varnames(this.function);
    this.argnames = argnames;
    this.kwargnames = kwargnames;
    this.opts = opts;
    this.warn_on_impl = opts.warn_on_impl ?? null;
    this.warn_on_impl_args = opts.warn_on_impl_args ?? null;
  }
}
