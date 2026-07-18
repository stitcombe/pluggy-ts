/** Port of testing/test_result.py. */

import { expect, test } from "vitest";
import { Result } from "../src/index.js";

test("exceptions traceback doesnt get longer and longer", () => {
  // Python guards against tracebacks growing on each re-raise; the JS
  // equivalent is that the same error object with an unchanged stack is
  // re-thrown every time.
  const bad = (): void => {
    throw new Error("division by zero");
  };

  const result = Result.from_call(bad);

  const stacks: Array<string | undefined> = [];
  for (let i = 0; i < 3; i++) {
    try {
      result.get_result();
      expect.unreachable();
    } catch (exc) {
      stacks.push((exc as Error).stack);
    }
  }

  expect(stacks[0]).toBe(stacks[1]);
  expect(stacks[1]).toBe(stacks[2]);
});
