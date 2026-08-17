import assert from "node:assert/strict";
import test from "node:test";
import { createApproval, matchingSprintPilotBranch, parseChangedPaths, readApproval, releaseApproval, sprintPilotBranchName, sprintPilotTicketTail, sprintPilotWorktreeAddArgs } from "./sprintpilot-server.ts";

test("branches and worktrees share the Jira key and title tail", () => {
  const tail = sprintPilotTicketTail("DEV-123", "Add repository chooser");
  assert.equal(tail, "DEV-123-Add-repository-chooser");
  assert.equal(sprintPilotBranchName("DEV-123", "Add repository chooser"), `nir/${tail}`);
  assert.equal(sprintPilotBranchName("DEV-456", ""), "nir/DEV-456-task");
});

test("recreates a deleted worktree by reusing its retained branch", () => {
  const branch = "nir/DEV-26461-Enable-E2E-sanity";
  const worktree = "/repos/workflows-DEV-26461-Enable-E2E-sanity";
  assert.deepEqual(sprintPilotWorktreeAddArgs(branch, worktree, true), ["worktree", "add", worktree, branch]);
  assert.deepEqual(sprintPilotWorktreeAddArgs(branch, worktree, false), ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/main"]);
});

test("finds a retained branch despite case differences on case-insensitive filesystems", () => {
  const retained = "nir/DEV-26461-enable-e2e-sanity-on-preprod-production-ho";
  const requested = "nir/DEV-26461-Enable-E2E-sanity-on-preprod-production-ho";
  assert.equal(matchingSprintPilotBranch(["main", retained], requested), retained);
});

test("an unstaged record keeps its leading space and is still reported", () => {
  // `run()` trims, which would shift this record's status field and silently
  // drop the operator's first changed file. changedPaths reads raw stdout.
  const output = " M .github/actions/automation/e2e-classify/action.yml\0 M .github/workflows/e2e.yml\0";
  assert.deepEqual([...parseChangedPaths(output)].sort(), [
    ".github/actions/automation/e2e-classify/action.yml",
    ".github/workflows/e2e.yml",
  ]);
});

test("a trimmed porcelain string loses its first record, which is why raw stdout is used", () => {
  const output = " M first.yml\0 M second.yml\0";
  assert.equal(parseChangedPaths(output.trim()).has("first.yml"), false);
  assert.equal(parseChangedPaths(output).has("first.yml"), true);
});

test("changed paths are parsed from NUL-separated porcelain output", () => {
  const output = "M  automation/config/env/dev.yaml\0A  automation/drivers/mobile/gate.py\0?? notes.md\0";
  assert.deepEqual([...parseChangedPaths(output)].sort(), [
    "automation/config/env/dev.yaml",
    "automation/drivers/mobile/gate.py",
    "notes.md",
  ]);
});

test("a rename reports both names and does not swallow the next entry", () => {
  const output = "R  new/name.py\0old/name.py\0M  other.py\0";
  assert.deepEqual([...parseChangedPaths(output)].sort(), ["new/name.py", "old/name.py", "other.py"]);
});

test("approvals do not expire and survive a failed commit", () => {
  const token = createApproval("/wt", ["a.py"], "hash-1");
  assert.deepEqual(readApproval(token), { cwd: "/wt", files: ["a.py"], hash: "hash-1" });
  // Reading must not consume it: a `git add` that refuses an ignored path used
  // to burn the approval and report "Approval expired" on every retry.
  assert.deepEqual(readApproval(token).files, ["a.py"]);
  releaseApproval(token);
  assert.throws(() => readApproval(token), /no longer available/);
});

test("an approval record carries no expiry", () => {
  const token = createApproval("/wt", ["a.py"], "hash-1");
  assert.deepEqual(Object.keys(readApproval(token)).sort(), ["cwd", "files", "hash"]);
});
