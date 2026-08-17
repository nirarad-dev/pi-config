import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("pending-change counts are batched across worktrees", () => {
  assert.match(route, /searchParams\.get\("worktrees"\)/);
  assert.match(route, /MAX_WORKTREES/);
  assert.match(route, /Promise\.all/);
});

test("every requested worktree passes the sprint guard before git runs", () => {
  assert.match(route, /assertSprintWorktree/);
});

test("one unreadable worktree does not fail the whole poll", () => {
  assert.match(route, /catch \{/);
  assert.match(route, /entry !== undefined/);
});

test("staged files are counted from the index status, not the display kind", () => {
  assert.match(route, /file\.indexStatus/);
});
