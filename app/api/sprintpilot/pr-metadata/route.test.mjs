import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("PR metadata is based on the branch diff and maps the workflows repository to Automation", () => {
  assert.match(route, /origin\/main\.\.\.HEAD/);
  assert.match(route, /repo === "workflows"/);
  assert.match(route, /"Automation"/);
});
