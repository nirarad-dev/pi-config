import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("a worktree without automation tests leaves the picker empty", () => {
  assert.match(route, /if \(!existsSync\(root\)\) return NextResponse\.json\(\{ files \}\);/);
  assert.match(route, /walk\(root\);/);
});
