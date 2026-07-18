/**
 * Port of pluggy/_manager.py.
 *
 * `load_setuptools_entrypoints` has no importlib.metadata to query in
 * JavaScript; instead a distribution provider can be installed with
 * `setDistributions()` (the analog of monkeypatching
 * `importlib.metadata.distributions` in the Python tests).
 */

import { _multicall } from "./callers.js";
import { assert_, ValueError } from "./errors.js";
import {
  AnyFunction,
  dirObject,
  getAttr,
  hasAttr,
  HookCaller,
  HookExec,
  HookImpl,
  HookimplOpts,
  HookRelay,
  HookspecOpts,
  isGeneratorFunction,
  makeHookRelay,
  Namespace,
  normalize_hookimpl_opts,
  parseParamSource,
  Plugin,
  repr,
  _SubsetHookCaller,
} from "./hooks.js";
import { Result } from "./result.js";
import { TagTracer, TagTracerSub } from "./tracing.js";
import { warn, Warning } from "./warnings.js";

export type BeforeTrace = (
  hook_name: string,
  hook_impls: HookImpl[],
  kwargs: Record<string, unknown>,
) => void;
export type AfterTrace = (
  outcome: Result<unknown>,
  hook_name: string,
  hook_impls: HookImpl[],
  kwargs: Record<string, unknown>,
) => void;

function _warn_for_function(warning: Warning, _function: AnyFunction): void {
  // Python attaches the implementation's file/line via warn_explicit;
  // JavaScript functions expose no such metadata, so just emit the warning.
  warn(warning);
}

/** Plugin failed validation. */
export class PluginValidationError extends Error {
  /** The plugin which failed validation. */
  plugin: Plugin;

  constructor(plugin: Plugin, message: string) {
    super(message);
    this.name = "PluginValidationError";
    this.plugin = plugin;
  }
}

// ---------------------------------------------------------------------------
// Entry point loading (setuptools analog)
// ---------------------------------------------------------------------------

export interface EntryPoint {
  name: string;
  group: string;
  value?: string;
  load(): Plugin;
}

export interface Distribution {
  entry_points: readonly EntryPoint[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

let _distributions: () => Iterable<Distribution> = () => [];

/**
 * Install the provider consulted by `load_setuptools_entrypoints`.
 * Returns the previous provider so tests can restore it.
 */
export function setDistributions(
  provider: () => Iterable<Distribution>,
): () => Iterable<Distribution> {
  const old = _distributions;
  _distributions = provider;
  return old;
}

/** Emulate a pkg_resources Distribution (attribute access proxies to _dist). */
export class DistFacade {
  declare _dist: Distribution;

  constructor(dist: Distribution) {
    this._dist = dist;
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return (target._dist as any)[prop];
      },
      ownKeys(target) {
        const keys = new Set<string | symbol>([
          ...Reflect.ownKeys(target._dist),
          "_dist",
          "project_name",
        ]);
        return [...keys];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop in target || prop in target._dist) {
          return { configurable: true, enumerable: true, writable: false };
        }
        return undefined;
      },
    });
  }

  get project_name(): string {
    return String((this._dist.metadata as any)?.name);
  }
}

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

let objectIdCounter = 0;
const objectIds = new WeakMap<object, number>();

function objectId(value: unknown): string {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    let id = objectIds.get(value as object);
    if (id === undefined) {
      id = ++objectIdCounter;
      objectIds.set(value as object, id);
    }
    return String(id);
  }
  return String(value);
}

/**
 * Core class which manages registration of plugin objects and 1:N hook
 * calling.
 *
 * You can register new hooks by calling `add_hookspecs(module_or_class)`.
 * You can register plugin objects (which contain hook implementations) by
 * calling `register(plugin)`.
 *
 * For debugging purposes you can call `enable_tracing()` which will
 * subsequently send debug information to the trace helper.
 */
export class PluginManager {
  /** The project name. */
  readonly project_name: string;
  readonly _name2plugin: Map<string, Plugin | null> = new Map();
  readonly _plugin_distinfo: Array<[Plugin, DistFacade]> = [];
  /** The "hook relay", used to call a hook on all registered plugins. */
  readonly hook: HookRelay;
  /** The tracing entry point. */
  readonly trace: TagTracerSub;
  _inner_hookexec: HookExec;
  readonly _hookexec: HookExec;

  constructor(project_name: string) {
    this.project_name = project_name;
    this.hook = makeHookRelay();
    this.trace = new TagTracer().get("pluginmanage");
    this._inner_hookexec = _multicall;
    // called from all hookcaller instances.
    // enable_tracing will set its own wrapping function at _inner_hookexec.
    this._hookexec = (hook_name, methods, kwargs, firstresult) =>
      this._inner_hookexec(hook_name, methods, kwargs, firstresult);
  }

  /**
   * Register a plugin and return its name.
   *
   * If the name is not specified, a name is generated using
   * `get_canonical_name`. If the name is blocked from registering, returns
   * null. If the plugin is already registered, raises a ValueError.
   */
  register(plugin: Plugin, name?: string | null): string | null {
    const plugin_name = name || this.get_canonical_name(plugin);

    if (this._name2plugin.has(plugin_name)) {
      if (this._name2plugin.get(plugin_name) === null) {
        return null; // blocked plugin, return null to indicate no registration
      }
      throw new ValueError(
        `Plugin name already registered: ${plugin_name}=${plugin}\n` +
          `${mapRepr(this._name2plugin)}`,
      );
    }

    for (const value of this._name2plugin.values()) {
      if (value === plugin) {
        throw new ValueError(
          `Plugin already registered under a different name: ` +
            `${plugin_name}=${plugin}\n${mapRepr(this._name2plugin)}`,
        );
      }
    }

    // XXX if an error happens we should make sure no state has been
    // changed at point of return
    this._name2plugin.set(plugin_name, plugin);

    // register matching hook implementations of the plugin
    for (const attrname of dirObject(plugin)) {
      const hookimpl_opts = this.parse_hookimpl_opts(plugin, attrname);
      if (hookimpl_opts != null) {
        normalize_hookimpl_opts(hookimpl_opts);
        const method = getAttr(plugin, attrname);
        const hookimpl = new HookImpl(
          plugin,
          plugin_name,
          method,
          hookimpl_opts as HookimplOpts,
        );
        const hook_name = hookimpl_opts.specname || attrname;
        let hook: HookCaller | undefined = this.hook[hook_name];
        if (hook === undefined) {
          hook = new HookCaller(hook_name, this._hookexec);
          this.hook[hook_name] = hook;
        } else if (hook.has_spec()) {
          this._verify_hook(hook, hookimpl);
          hook._maybe_apply_history(hookimpl);
        }
        hook._add_hookimpl(hookimpl);
      }
    }
    return plugin_name;
  }

  /**
   * Try to obtain a hook implementation from an item with the given name in
   * the given plugin which is being searched for hook impls.
   *
   * Returns the parsed hookimpl options, or null to skip the given item.
   * This method can be overridden by PluginManager subclasses to customize
   * how hook implementations are picked up.
   */
  parse_hookimpl_opts(
    plugin: Plugin,
    name: string,
  ): Partial<HookimplOpts> | null {
    let method: unknown;
    try {
      method = getAttr(plugin, name);
    } catch {
      return null;
    }
    if (typeof method !== "function") {
      return null;
    }
    let res: unknown;
    try {
      res = (method as any)[this.project_name + "_impl"] ?? null;
    } catch {
      res = {};
    }
    if (res !== null && typeof res !== "object") {
      // false positive
      res = null;
    }
    return res as Partial<HookimplOpts> | null;
  }

  /**
   * Unregister a plugin and all of its hook implementations.
   *
   * The plugin can be specified either by the plugin object or the plugin
   * name. If both are specified, they must agree.
   * Returns the unregistered plugin, or null if not found.
   */
  unregister(plugin?: Plugin | null, name?: string | null): Plugin | null {
    if (name == null) {
      assert_(plugin != null, "one of name or plugin needs to be specified");
      name = this.get_name(plugin);
      assert_(name != null, "plugin is not registered");
    }

    if (plugin == null) {
      plugin = this.get_plugin(name);
      if (plugin == null) {
        return null;
      }
    }

    const hookcallers = this.get_hookcallers(plugin);
    if (hookcallers) {
      for (const hookcaller of hookcallers) {
        hookcaller._remove_plugin(plugin);
      }
    }

    // if _name2plugin[name] == null, registration was blocked: ignore
    if (this._name2plugin.get(name) != null) {
      this._name2plugin.delete(name);
    }

    return plugin;
  }

  /** Block registrations of the given name, unregister if already registered. */
  set_blocked(name: string): void {
    this.unregister(null, name);
    this._name2plugin.set(name, null);
  }

  /** Return whether the given plugin name is blocked. */
  is_blocked(name: string): boolean {
    return this._name2plugin.has(name) && this._name2plugin.get(name) === null;
  }

  /**
   * Unblocks a name. Returns whether the name was actually blocked.
   */
  unblock(name: string): boolean {
    if (this._name2plugin.has(name) && this._name2plugin.get(name) === null) {
      this._name2plugin.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Add new hook specifications defined in the given module_or_class.
   * Functions are recognized as hook specifications if they have been
   * decorated with a matching HookspecMarker.
   */
  add_hookspecs(module_or_class: Namespace): void {
    const names: string[] = [];
    for (const name of dirObject(module_or_class)) {
      const spec_opts = this.parse_hookspec_opts(module_or_class, name);
      if (spec_opts != null) {
        let hc: HookCaller | undefined = this.hook[name];
        if (hc === undefined) {
          hc = new HookCaller(name, this._hookexec, module_or_class, spec_opts);
          this.hook[name] = hc;
        } else {
          // Plugins registered this hook without knowing the spec.
          hc.set_specification(module_or_class, spec_opts);
          for (const hookfunction of hc.get_hookimpls()) {
            this._verify_hook(hc, hookfunction);
          }
        }
        names.push(name);
      }
    }

    if (!names.length) {
      throw new ValueError(
        `did not find any ${repr(this.project_name)} hooks in ${module_or_class}`,
      );
    }
  }

  /**
   * Try to obtain a hook specification from an item with the given name in
   * the given module or class which is being searched for hook specs.
   *
   * Returns the parsed hookspec options for defining a hook, or null to
   * skip the given item. This method can be overridden by PluginManager
   * subclasses to customize how hook specifications are picked up.
   */
  parse_hookspec_opts(
    module_or_class: Namespace,
    name: string,
  ): HookspecOpts | null {
    const method = getAttr(module_or_class, name);
    if (method == null) {
      return null;
    }
    let opts: unknown;
    try {
      opts = method[this.project_name + "_spec"] ?? null;
    } catch {
      return null;
    }
    return opts as HookspecOpts | null;
  }

  /** Return a set of all registered plugin objects. */
  get_plugins(): Set<Plugin> {
    const out = new Set<Plugin>();
    for (const value of this._name2plugin.values()) {
      if (value !== null) {
        out.add(value);
      }
    }
    return out;
  }

  /** Return whether the plugin is already registered. */
  is_registered(plugin: Plugin): boolean {
    for (const value of this._name2plugin.values()) {
      if (value === plugin) {
        return true;
      }
    }
    return false;
  }

  /**
   * Return a canonical name for a plugin object.
   *
   * Note that a plugin may be registered under a different name specified
   * by the caller of `register(plugin, name)`. To obtain the name of a
   * registered plugin use `get_name(plugin)` instead.
   */
  get_canonical_name(plugin: Plugin): string {
    const name = getAttr(plugin, "__name__");
    if (typeof name === "string" && name) {
      return name;
    }
    return objectId(plugin);
  }

  /** Return the plugin registered under the given name, if any. */
  get_plugin(name: string): Plugin | null {
    return this._name2plugin.get(name) ?? null;
  }

  /** Return whether a plugin with the given name is registered. */
  has_plugin(name: string): boolean {
    return this.get_plugin(name) !== null;
  }

  /** Return the name the plugin is registered under, or null if it isn't. */
  get_name(plugin: Plugin): string | null {
    for (const [name, value] of this._name2plugin.entries()) {
      if (value === plugin) {
        return name;
      }
    }
    return null;
  }

  _verify_hook(hook: HookCaller, hookimpl: HookImpl): void {
    if (hook.is_historic() && (hookimpl.hookwrapper || hookimpl.wrapper)) {
      throw new PluginValidationError(
        hookimpl.plugin,
        `Plugin ${repr(hookimpl.plugin_name)}\nhook ${repr(hook.name)}\n` +
          "historic incompatible with yield/wrapper/hookwrapper",
      );
    }

    const spec = hook.spec;
    assert_(spec !== null);
    if (spec.warn_on_impl) {
      _warn_for_function(spec.warn_on_impl, hookimpl.function);
    }

    // positional arg checking
    const specArgs = new Set(spec.argnames);
    const notinspec = hookimpl.argnames.filter((a) => !specArgs.has(a));
    if (notinspec.length) {
      throw new PluginValidationError(
        hookimpl.plugin,
        `Plugin ${repr(hookimpl.plugin_name)} for hook ${repr(hook.name)}\n` +
          `hookimpl definition: ${_formatdef(hookimpl.function)}\n` +
          `Argument(s) {${notinspec.map(repr).join(", ")}} are declared in the ` +
          "hookimpl but can not be found in the hookspec",
      );
    }

    if (spec.warn_on_impl_args) {
      for (const hookimpl_argname of hookimpl.argnames) {
        const argname_warning = spec.warn_on_impl_args[hookimpl_argname];
        if (argname_warning != null) {
          _warn_for_function(argname_warning, hookimpl.function);
        }
      }
    }

    if (
      (hookimpl.wrapper || hookimpl.hookwrapper) &&
      !isGeneratorFunction(hookimpl.function)
    ) {
      throw new PluginValidationError(
        hookimpl.plugin,
        `Plugin ${repr(hookimpl.plugin_name)} for hook ${repr(hook.name)}\n` +
          `hookimpl definition: ${_formatdef(hookimpl.function)}\n` +
          "Declared as wrapper=True or hookwrapper=True " +
          "but function is not a generator function",
      );
    }

    if (hookimpl.wrapper && hookimpl.hookwrapper) {
      throw new PluginValidationError(
        hookimpl.plugin,
        `Plugin ${repr(hookimpl.plugin_name)} for hook ${repr(hook.name)}\n` +
          `hookimpl definition: ${_formatdef(hookimpl.function)}\n` +
          "The wrapper=True and hookwrapper=True options are mutually exclusive",
      );
    }
  }

  /**
   * Verify that all hooks which have not been verified against a hook
   * specification are optional, otherwise raise PluginValidationError.
   */
  check_pending(): void {
    for (const name of Object.keys(this.hook)) {
      if (name[0] === "_") {
        continue;
      }
      const hook = this.hook[name];
      if (!hook.has_spec()) {
        for (const hookimpl of hook.get_hookimpls()) {
          if (!hookimpl.optionalhook) {
            throw new PluginValidationError(
              hookimpl.plugin,
              `unknown hook ${repr(name)} in plugin ${hookimpl.plugin}`,
            );
          }
        }
      }
    }
  }

  /**
   * Load modules from querying the specified setuptools group.
   * Returns the number of plugins loaded by this call.
   */
  load_setuptools_entrypoints(group: string, name?: string | null): number {
    let count = 0;
    for (const dist of [..._distributions()]) {
      for (const ep of dist.entry_points) {
        if (
          ep.group !== group ||
          (name != null && ep.name !== name) ||
          // already registered
          this.get_plugin(ep.name) != null ||
          this.is_blocked(ep.name)
        ) {
          continue;
        }
        const plugin = ep.load();
        this.register(plugin, ep.name);
        this._plugin_distinfo.push([plugin, new DistFacade(dist)]);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Return a list of [plugin, distinfo] pairs for all setuptools-registered
   * plugins.
   */
  list_plugin_distinfo(): Array<[Plugin, DistFacade]> {
    return [...this._plugin_distinfo];
  }

  /** Return a list of [name, plugin] pairs for all registered plugins. */
  list_name_plugin(): Array<[string, Plugin]> {
    return [...this._name2plugin.entries()];
  }

  /**
   * Get all hook callers for the specified plugin, or null if the plugin is
   * not registered in this plugin manager.
   */
  get_hookcallers(plugin: Plugin): HookCaller[] | null {
    if (this.get_name(plugin) === null) {
      return null;
    }
    const hookcallers: HookCaller[] = [];
    for (const hookcaller of Object.values(this.hook)) {
      if (
        hookcaller.get_hookimpls().some((impl) => impl.plugin === plugin)
      ) {
        hookcallers.push(hookcaller);
      }
    }
    return hookcallers;
  }

  /**
   * Add before/after tracing functions for all hooks.
   * Returns an undo function which, when called, removes the added tracers.
   *
   * `before(hook_name, hook_impls, kwargs)` will be called ahead of all
   * hook calls and receive a hookcaller instance, a list of HookImpl
   * instances and the keyword arguments for the hook call.
   *
   * `after(outcome, hook_name, hook_impls, kwargs)` receives the same
   * arguments as `before` but also a `Result` object which represents the
   * result of the overall hook call.
   */
  add_hookcall_monitoring(before: BeforeTrace, after: AfterTrace): () => void {
    const oldcall = this._inner_hookexec;

    const traced_hookexec: HookExec = (
      hook_name,
      hook_impls,
      caller_kwargs,
      firstresult,
    ) => {
      before(hook_name, hook_impls, caller_kwargs);
      const outcome = Result.from_call(() =>
        oldcall(hook_name, hook_impls, caller_kwargs, firstresult),
      );
      after(outcome, hook_name, hook_impls, caller_kwargs);
      return outcome.get_result();
    };

    this._inner_hookexec = traced_hookexec;

    return () => {
      this._inner_hookexec = oldcall;
    };
  }

  /**
   * Enable tracing of hook calls.
   * Returns an undo function which, when called, removes the added tracing.
   */
  enable_tracing(): () => void {
    const hooktrace = this.trace.root.get("hook");

    const before: BeforeTrace = (hook_name, _methods, kwargs) => {
      hooktrace.root.indent += 1;
      hooktrace(hook_name, kwargs);
    };

    const after: AfterTrace = (outcome, hook_name, _methods, _kwargs) => {
      if (outcome.exception == null) {
        hooktrace("finish", hook_name, "-->", outcome.get_result());
      }
      hooktrace.root.indent -= 1;
    };

    return this.add_hookcall_monitoring(before, after);
  }

  /**
   * Return a proxy HookCaller instance for the named method which manages
   * calls to all registered plugins except the ones from remove_plugins.
   */
  subset_hook_caller(
    name: string,
    remove_plugins: Iterable<Plugin>,
  ): HookCaller {
    const orig = this.hook[name];
    const plugins_to_remove = new Set<Plugin>();
    for (const plug of remove_plugins) {
      if (hasAttr(plug, name)) {
        plugins_to_remove.add(plug);
      }
    }
    if (plugins_to_remove.size) {
      return new _SubsetHookCaller(orig, plugins_to_remove);
    }
    return orig;
  }
}

function mapRepr(map: Map<string, Plugin | null>): string {
  const parts: string[] = [];
  for (const [key, value] of map.entries()) {
    parts.push(`${repr(key)}: ${value === null ? "None" : String(value)}`);
  }
  return `{${parts.join(", ")}}`;
}

export function _formatdef(func: AnyFunction): string {
  return `${func.name}(${parseParamSource(func).join(", ")})`;
}
