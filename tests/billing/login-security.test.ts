import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("the browser login flow never writes authentication secrets to the console", () => {
  const source = readFileSync(resolve(root, "app/login/page.tsx"), "utf8");

  assert.doesNotMatch(source, /console\.(?:log|debug|info)\s*\(/);
});
