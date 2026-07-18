/** Port of testing/test_tracer.py. */

import { beforeEach, expect, test } from "vitest";
import { TagTracer } from "../src/tracing.js";

let rootlogger: TagTracer;

beforeEach(() => {
  rootlogger = new TagTracer();
});

test("simple", () => {
  const log = rootlogger.get("pytest");
  log("hello");
  const out: string[] = [];
  rootlogger.setwriter((s) => out.push(s));
  log("world");
  expect(out.length).toBe(1);
  expect(out[0]).toBe("world [pytest]\n");
  const sublog = log.get("collection");
  sublog("hello");
  expect(out[1]).toBe("hello [pytest:collection]\n");
});

test("indent", () => {
  const log = rootlogger.get("1");
  const out: string[] = [];
  log.root.setwriter((arg) => out.push(arg));
  log("hello");
  log.root.indent += 1;
  log("line1");
  log("line2");
  log.root.indent += 1;
  log("line3");
  log("line4");
  log.root.indent -= 1;
  log("line5");
  log.root.indent -= 1;
  log("last");
  expect(out.length).toBe(7);
  const names = out.map((x) => x.slice(0, x.lastIndexOf(" [")));
  expect(names).toEqual([
    "hello",
    "  line1",
    "  line2",
    "    line3",
    "    line4",
    "  line5",
    "last",
  ]);
});

test("readable output dictargs", () => {
  const out = rootlogger._format_message(["test"], [1]);
  expect(out).toBe("1 [test]\n");

  const out2 = rootlogger._format_message(["test"], ["test", { a: 1 }]);
  expect(out2).toBe("test [test]\n    a: 1\n");
});

test("setprocessor", () => {
  const log = rootlogger.get("1");
  const log2 = log.get("2");
  expect(log2.tags).toEqual(["1", "2"]);
  const out: Array<[readonly string[], readonly unknown[]]> = [];
  rootlogger.setprocessor(["1", "2"], (tags, args) => out.push([tags, args]));
  log("not seen");
  log2("seen");
  expect(out.length).toBe(1);
  const [tags, args] = out[0];
  expect(tags).toContain("1");
  expect(tags).toContain("2");
  expect(args).toEqual(["seen"]);
  const l2: Array<[readonly string[], readonly unknown[]]> = [];
  rootlogger.setprocessor("1:2", (tags, args) => l2.push([tags, args]));
  log2("seen");
  const [, args2] = l2[0];
  expect(args2).toEqual(["seen"]);
});
