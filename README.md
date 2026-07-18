# pluggy-ts

A TypeScript port of [pluggy](https://github.com/pytest-dev/pluggy), the
plugin and hook calling framework underlying pytest, tox, and devpi.

pluggy-ts lets a host program define **hook specifications** (the contract)
and lets any number of **plugins** provide **hook implementations**. Calling
a hook runs every registered implementation and collects the results — with
ordering control (`tryfirst`/`trylast`), wrappers that run around all other
implementations, first-result-only hooks, historic hooks that replay onto
late-registered plugins, and validation of implementations against the spec.

The complete pluggy unit test suite has been ported alongside the library
and passes in full — see `PORTING_NOTES.md` for the module mapping and every
deliberate deviation from the Python original.

## Installation

The package ships compiled ESM JavaScript plus type declarations in `dist/`.
It has zero runtime dependencies and requires Node 18+.

Until it's published to a registry, install it straight from the repo:

```sh
# from a checkout (creates pluggy-ts-1.0.0.tgz)
cd pluggy-ts && npm install && npm pack

# in your project
npm install /path/to/pluggy-ts/pluggy-ts-1.0.0.tgz
```

or reference the checkout directly (npm will run `prepack`/`build`):

```sh
npm install /path/to/pluggy-ts
# or, from git:
npm install git+https://github.com/loon-labs/pluggy-ts.git
```

Then import it like any package:

```ts
import { HookimplMarker, HookspecMarker, PluginManager } from "pluggy-ts";
```

Notes for consumers:

- **ESM only.** Your project should have `"type": "module"` (or import it
  from an `.mts` file / a bundler). There is no CommonJS build.
- Works with `"moduleResolution": "NodeNext"` or `"Bundler"`; declarations
  (`.d.ts` + source maps) are included, so go-to-definition lands in
  readable code.
- Inside this repo (or a monorepo), you can also import the sources
  directly: `import { PluginManager } from "./pluggy-ts/src/index.js"`.

## A complete example

```ts
import { HookimplMarker, HookspecMarker, PluginManager } from "pluggy-ts";

// 1. Create the markers for your project. The name links specs, impls and
//    the manager together — plugins written for a different project name
//    are ignored.
const hookspec = new HookspecMarker("myproject");
const hookimpl = new HookimplMarker("myproject");

// 2. Define hook specifications: a namespace of marked functions. The
//    parameter names are the contract — implementations may accept any
//    subset of them.
const MySpec = {
  setup_item: hookspec(function setup_item(item: string, config: object) {}),
  // firstresult: stop at the first implementation returning non-null.
  resolve_name: hookspec({ firstresult: true })(function resolve_name(
    name: string,
  ) {}),
};

// 3. Write plugins: namespaces of marked implementations. Object literals
//    work well; each impl declares only the parameters it needs.
const pluginA = {
  setup_item: hookimpl(function setup_item(item: string) {
    return `A saw ${item}`;
  }),
};

// Wrappers run around all non-wrapper implementations: code before `yield`
// runs first, `yield` runs the others and evaluates to their result, the
// return value becomes the hook's result.
const tracer = {
  setup_item: hookimpl({ wrapper: true })(function* setup_item(): Generator<
    undefined,
    unknown,
    unknown
  > {
    console.time("setup_item");
    try {
      return yield;
    } finally {
      console.timeEnd("setup_item");
    }
  }),
};

// Class-based plugins work too: implementations are found on the prototype
// chain and invoked with `this` bound to the instance.
class CounterPlugin {
  count = 0;
  setup_item(this: CounterPlugin, item: string, config: object): string {
    this.count += 1;
    return `#${this.count}: ${item}`;
  }
}
hookimpl(CounterPlugin.prototype.setup_item);

// 4. Wire it up.
const pm = new PluginManager("myproject");
pm.add_hookspecs(MySpec);
pm.register(pluginA);
pm.register(tracer);
pm.register(new CounterPlugin(), "counter"); // optional explicit name
pm.check_pending(); // error on impls that match no spec

// 5. Call hooks. Python's keyword arguments become one object argument;
//    results come back newest-registration-first.
const results = pm.hook.setup_item({ item: "widget", config: {} });
// → ["#1: widget", "A saw widget"]
```

### Ordering

Within a hook, implementations execute in this order:

1. `tryfirst: true` non-wrappers
2. plain non-wrappers (last registered first)
3. `trylast: true` non-wrappers
4. wrappers enclose all of the above (`tryfirst` wrappers outermost)

```ts
const p = {
  myhook: hookimpl({ trylast: true })(function myhook() { /* runs late */ }),
};
```

### Hook options at a glance

| Marker call | Effect |
| --- | --- |
| `hookspec({firstresult: true})` | Call stops at the first non-null result; hook returns a single value instead of a list. |
| `hookspec({historic: true})` | Call is memorized and replayed on plugins registered later. Call via `call_historic`. |
| `hookspec({warn_on_impl: w})` | Emit warning `w` whenever the hook is implemented. |
| `hookspec({warn_on_impl_args: {argName: w}})` | Warn when an impl requests a given argument. |
| `hookimpl({tryfirst / trylast: true})` | Ordering hint (see above). |
| `hookimpl({wrapper: true})` | Generator wrapper; `yield` returns the inner result, thrown errors propagate, the return value replaces the result. |
| `hookimpl({hookwrapper: true})` | Old-style wrapper; `yield` receives a `Result` to inspect/`force_result`/`force_exception`. |
| `hookimpl({optionalhook: true})` | Don't fail `check_pending()` when no spec matches. |
| `hookimpl({specname: "other"})` | Match the impl to spec `"other"` instead of the function name. |

### Historic hooks

```ts
const Spec = {
  configured: hookspec({ historic: true })(function configured(config: object) {}),
};
pm.add_hookspecs(Spec);

pm.hook.configured.call_historic(null, { config: { debug: true } });

// Plugins registered afterwards still receive the call:
pm.register({
  configured: hookimpl(function configured(config: object) {
    console.log("late plugin sees", config);
  }),
});
```

### Error handling and monitoring

```ts
import { addWarningHandler, PluginValidationError } from "pluggy-ts";

// Validation errors carry the offending plugin:
try {
  pm.register(badPlugin);
} catch (e) {
  if (e instanceof PluginValidationError) console.error(e.plugin, e.message);
}

// Library warnings (spec-argument mismatches, teardown errors, ...) go to
// console.warn by default; install a handler to route them elsewhere:
const unsubscribe = addWarningHandler((w) => myLogger.warn(w.message));

// Before/after instrumentation of every hook call:
const undo = pm.add_hookcall_monitoring(
  (hookName, impls, kwargs) => {},
  (outcome, hookName, impls, kwargs) => {},
);
```

## API reference

All names mirror the Python API (snake_case methods included).

### `new PluginManager(projectName)`

| Member | Description |
| --- | --- |
| `hook` | The hook relay: `pm.hook.<name>(kwargsObject)` calls a hook. |
| `register(plugin, name?)` | Register a plugin; returns its name, or `null` if the name is blocked. Throws `ValueError` on duplicates. |
| `unregister(plugin?, name?)` | Remove a plugin (by object or name); returns it. |
| `add_hookspecs(namespace)` | Discover marked specs on an object, class, or instance. |
| `check_pending()` | Throw `PluginValidationError` for impls with no matching spec (unless `optionalhook`). |
| `set_blocked(name)` / `is_blocked(name)` / `unblock(name)` | Manage blocked plugin names. |
| `get_plugin(name)` / `has_plugin(name)` / `get_name(plugin)` | Lookups. |
| `get_plugins()` / `list_name_plugin()` | Enumerate registrations. |
| `is_registered(plugin)` / `get_canonical_name(plugin)` | Registration status / default naming. |
| `get_hookcallers(plugin)` | Hook callers the plugin participates in. |
| `subset_hook_caller(name, removePlugins)` | A proxy caller that skips the given plugins. |
| `add_hookcall_monitoring(before, after)` | Wrap every hook call; returns an undo function. |
| `enable_tracing()` | Debug tracing via `pm.trace.root.setwriter(...)`; returns undo. |
| `load_setuptools_entrypoints(group, name?)` | Load plugins from the provider installed with `setDistributions()`. |
| `parse_hookimpl_opts` / `parse_hookspec_opts` | Override points for custom discovery (subclass `PluginManager`). |

### Hook callers (`pm.hook.<name>`)

| Member | Description |
| --- | --- |
| `(kwargsObject)` | Call the hook. Returns an array of non-null results, or a single value for `firstresult` specs. |
| `call_historic(resultCallback?, kwargs?)` | Call a historic hook; `resultCallback` receives each non-null result, including from future registrations. |
| `call_extra(methods, kwargs)` | Call with extra one-off implementations. |
| `get_hookimpls()` | The registered `HookImpl`s in call order. |
| `has_spec()` / `is_historic()` / `spec` / `name` | Introspection. |

### Markers

- `new HookspecMarker(projectName)` → callable: `hookspec(fn)` or
  `hookspec(opts)(fn)`.
- `new HookimplMarker(projectName)` → callable: `hookimpl(fn)` or
  `hookimpl(opts)(fn)`.

### `Result<T>` (old-style wrappers, `Result.from_call`)

`get_result()` (returns or re-throws) · `force_result(v)` ·
`force_exception(e)` · `exception` · `excinfo`.

### Errors and warnings

`PluginValidationError` (with `.plugin`) · `HookCallError` (missing call
argument) · `ValueError` / `RuntimeError` / `AssertionError` stand-ins ·
warning classes `PluggyWarning`, `PluggyTeardownRaisedWarning`,
`UserWarning`, `DeprecationWarning`, plus `warn`, `addWarningHandler`,
`catchWarnings`.

### Utilities

`varnames(fn)` → `[required, defaulted]` parameter names ·
`setDistributions(provider)` → entry-point source for
`load_setuptools_entrypoints` · `__version__`.

## Differences from Python pluggy

- Hook calls take a **single kwargs object**: `pm.hook.f({x: 1})`.
- Decorators become **marker calls**: `hookimpl({wrapper: true})(fn)`.
- Wrappers are **generator functions** (`function*`).
- Implementations declaring parameters the caller didn't pass raise
  `HookCallError`; parameter names are read from `Function.toString()`, so
  impl parameter names must match the spec's (as in Python).
- See `PORTING_NOTES.md` for the full list, including warning/exception
  mapping and entry-point loading.

## Development

```sh
npm install
npm test          # vitest run (the ported pluggy test suite, 132 tests)
npm run typecheck # tsc --noEmit over src + tests
npm run build     # emit dist/ (ESM + .d.ts); also runs on `npm pack`
```

## Layout

- `src/` — the library (one module per Python source module).
- `test/` — the ported unit test suite.
- `dist/` — build output (generated; what the package ships).
- `PORTING_NOTES.md` — module mapping, API conventions, and every
  deliberate deviation from the Python original.
