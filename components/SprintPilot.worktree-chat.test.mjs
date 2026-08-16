import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sprintPilot = await readFile(new URL("./SprintPilot.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionReader = await readFile(new URL("../lib/session-reader.ts", import.meta.url), "utf8");

test("development chat exposes only sessions from the active worktree", () => {
  assert.match(sprintPilot, /scopeCwd=\$\{encodeURIComponent\(state\.worktree\)\}/);
  assert.match(sidebar, /if \(scopeCwd\) params\.set\("cwd", scopeCwd\)/);
  assert.match(sidebar, /A stale\/mismatched id must never escape a fixed worktree scope/);
  assert.match(sessionReader, /SessionManager\.list\(cwd\)/);
});
