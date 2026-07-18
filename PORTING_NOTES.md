# Porting notes: pluggy (Python) → pluggy-ts (TypeScript)

This is a faithful port of [pluggy](https://github.com/pytest-dev/pluggy)
(`src/pluggy/*.py`) and its complete unit test suite (`testing/*.py`) to
TypeScript, running under [vitest](https://vitest.dev).

## Module mapping

| Python              | TypeScript          |
| ------------------- | ------------------- |
| `pluggy/__init__.py`| `src/index.ts`      |
| `pluggy/_hooks.py`  | `src/hooks.ts`      |
| `pluggy/_callers.py`| `src/callers.ts`    |
| `pluggy/_manager.py`| `src/manager.ts`    |
| `pluggy/_result.py` | `src/result.ts`     |
| `pluggy/_tracing.py`| `src/tracing.ts`    |
| `pluggy/_warnings.py`| `src/warnings.ts`  |
| —                   | `src/errors.ts` (ValueError/RuntimeError/AssertionError stand-ins) |
| `testing/conftest.py`| `test/conftest.ts` (fixtures + pytest.warns emulation) |
| `testing/test_*.py` | `test/test_*.test.ts` |

## API conventions

- **Keyword arguments** become a single object argument:
  `pm.hook.myhook(arg=1)` → `pm.hook.myhook({arg: 1})`. `HookCaller` and
  `TagTracerSub` instances are real callable functions (the constructor
  returns a function re-prototyped onto the class), so the Python calling
  ergonomics are preserved.
- **Decorators** become marker calls. `@hookimpl(wrapper=True)` →
  `hookimpl({wrapper: true})(fn)`; bare `@hookimpl` → `hookimpl(fn)`.
  Options are stored on the function as `<project_name>_impl` /
  `<project_name>_spec`, exactly like Python.
- **Plugins/namespaces** are plain objects, classes, or class instances.
  `dir()`/`getattr()` are emulated by walking own + prototype properties
  (`dirObject`/`getAttr` in `src/hooks.ts`); for a class, prototype methods
  are seen like Python's unbound methods. Hook implementations are invoked
  with `this` bound to the plugin, so class-based plugins keep their state.
- **Wrappers** are generator functions (`function*`). JS generators map
  1:1: `send` → `next(v)`, `throw` → `throw(e)`, `close` → `return()`, and
  `StopIteration(v)` → `{done: true, value: v}`.
- **varnames()** parses `Function.prototype.toString()` instead of code
  objects. Required params → argnames; defaulted params → kwargnames; rest
  params and destructuring are excluded. A `__wrapped__` property is
  honored like `functools.wraps`. Objects with a `__call__` function
  property are treated as callables.
- **Warnings**: `src/warnings.ts` is a tiny emulation of Python's
  `warnings` module (subscriber list, default console output). Test-side,
  `expectWarns`/`recordWarnings`/`expectNoWarnings` in `test/conftest.ts`
  play the role of `pytest.warns`/`recwarn`.
- **Exceptions**: `ValueError`, `RuntimeError`, `AssertionError` are Error
  subclasses in `src/errors.ts` (library asserts throw `AssertionError`,
  matching the Python `assert` statements). `Error.cause` plays the role
  of `__cause__` (`raise ... from ...`); Python's *implicit* exception
  chaining is emulated by the call loop setting `__context__` on an error
  raised while another exception is in flight.
- **`load_setuptools_entrypoints`**: there is no `importlib.metadata`;
  a distribution provider is injected via `setDistributions()` (the analog
  of the Python test's monkeypatching). `DistFacade` proxies attribute
  access to the wrapped distribution.

## Test-by-test adaptations

Everything not listed here is a direct 1:1 translation.

### test_multicall
- `test_wrapper`: Python's `result * 2` doubles a *list* in the
  non-firstresult case; the JS wrapper spells out both cases explicitly.
- `test_hookwrapper_too_many_yield` / `test_wrapper_too_many_yield`: the
  original also asserts the source file path appears in the RuntimeError
  message; JS functions carry no file/line metadata, so only the function
  name is asserted.
- `test_wrapper_stopiteration_passtrough`: Python needs special handling
  because `StopIteration` cannot propagate through `gen.throw()` (#544).
  JS has no such trap — the ported test verifies the same observable
  behavior (teardown ordering + passthrough) without special-casing.
- Exception classes (`ValueError`, `SystemExit`, `StopIteration`) are
  local Error subclasses since JS has no equivalents.

### test_hookcaller
- `test_hook_conflict`: the error message's namespace repr is
  `<class 'Api1'>` rather than CPython's qualified
  `<class 'test_hookcaller.test_hook_conflict.<locals>.Api1'>`.
- `test_hookimpl` keeps Python's parametrization over
  `hookwrapper/optionalhook/tryfirst/trylast × True/False`.

### test_pluginmanager
- `test_register_dynamic_attr`: Python's `__getattr__` class is ported as
  a `Proxy` with a `get` trap.
- `test_call_with_too_few_args`: `0/0` doesn't throw in JS; the impl
  throws an explicit `ZeroDivisionError` Error subclass.
- `test_load_setuptools_instantiation`: monkeypatching
  `importlib.metadata.distributions` becomes `setDistributions()`.
- `he_pm`-based tests keep the fixture's spec-is-class /
  spec-is-instance parametrization via `describe.each`.

### test_details
- `test_warn_when_deprecated_specified` / `..._args_specified`: warning
  identity and ordering are asserted; the Python-side filename/lineno
  assertions are dropped (no such metadata on JS functions).
- `test_plugin_getattr_raises_errors`: the attribute-bomb object is a
  `Proxy` whose `get` throws.
- `test_dist_facade_list_attributes`: `dir(fc)` sorting is Python-specific;
  the port asserts the facade exposes `_dist` + `project_name` on top of
  the dist's own attributes.
- `test_wrapper_runtimeerror_passtrough` uses a local Error subclass.

### test_helpers
The original file mostly exercises CPython introspection that has no JS
equivalent. Direct ports: `test_varnames` (including the callable-object
case via the `__call__` convention), `test_varnames_default`,
`test_varnames_class`, `test_formatdef` (JS-formatted signatures, `...args`
instead of `*args/**kwargs`), `test_varnames_decorator` (via
`__wrapped__`). Replaced with the closest JS-meaningful equivalent:
keyword-only args → rest params; bound/unbound `self` stripping,
`@classmethod`, `legacy_noself` warning tests, and the Python 3.14
annotation-resolution test → covered by method/static/arrow parsing tests
(there is no implicit receiver to strip and no runtime annotations).

### test_warnings
- `test_teardown_raised_warning`: ported fully except the
  warning-filename assertion.
- `test_hookspec_missing_self_warns` and the two companion tests target
  the missing-`self` DeprecationWarning, which cannot exist in JS; the
  port keeps the invariant that a normal hookspec registration emits no
  warnings.

### test_result / test_tracer
Direct ports. `test_result` asserts the re-thrown error's stack is
unchanged across `get_result()` calls (the JS analog of "traceback doesn't
grow").

### Not ported
- `testing/benchmark.py` — pytest-benchmark performance harness, not part
  of the unit test suite.
- `test_warn_on_impl` deprecation-location details, PyPy-specific
  branches, and `DeprecationWarning`-suppression lists tied to Python
  packages (`pytest-timeout`).
