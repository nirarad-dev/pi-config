import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("reads lightweight monitor snapshots without sending agent commands", () => {
  assert.match(source, /session\.getMonitorState\(\)/);
  assert.doesNotMatch(source, /session\.send\(/);
  assert.match(source, /MAX_SESSIONS = 50/);
});
