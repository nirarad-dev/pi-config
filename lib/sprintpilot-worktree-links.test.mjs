import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetWorktreeLink, persistWorktreeLink, persistedWorktreeLinks } from "./sprintpilot-worktree-links.ts";

test("persists Jira worktree links across module reads", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sprintpilot-links-"));
  const original = process.env.SPRINTPILOT_STATE_FILE;
  process.env.SPRINTPILOT_STATE_FILE = path.join(directory, "state", "worktrees.json");
  t.after(async () => {
    if (original === undefined) delete process.env.SPRINTPILOT_STATE_FILE;
    else process.env.SPRINTPILOT_STATE_FILE = original;
    await rm(directory, { recursive: true, force: true });
  });

  persistWorktreeLink("/repos/arnac", "DEV-26018", "/repos/feature-26018");

  assert.equal(persistedWorktreeLinks("/repos/arnac").get("DEV-26018"), "/repos/feature-26018");
  const stored = JSON.parse(await readFile(process.env.SPRINTPILOT_STATE_FILE, "utf8"));
  assert.equal(stored.version, 1);
  assert.match(stored.repositories["/repos/arnac"]["DEV-26018"].linkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("removes only links that point to the deleted worktree", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sprintpilot-links-"));
  const original = process.env.SPRINTPILOT_STATE_FILE;
  process.env.SPRINTPILOT_STATE_FILE = path.join(directory, "worktrees.json");
  t.after(async () => {
    if (original === undefined) delete process.env.SPRINTPILOT_STATE_FILE;
    else process.env.SPRINTPILOT_STATE_FILE = original;
    await rm(directory, { recursive: true, force: true });
  });

  persistWorktreeLink("/repos/arnac", "DEV-1", "/repos/shared");
  persistWorktreeLink("/repos/arnac", "DEV-2", "/repos/shared");
  persistWorktreeLink("/repos/arnac", "DEV-3", "/repos/other");
  forgetWorktreeLink("/repos/arnac", "/repos/shared");

  assert.deepEqual([...persistedWorktreeLinks("/repos/arnac")], [["DEV-3", "/repos/other"]]);
});
