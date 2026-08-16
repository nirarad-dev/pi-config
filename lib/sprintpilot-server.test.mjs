import assert from "node:assert/strict";
import test from "node:test";
import { matchingSprintPilotBranch, sprintPilotBranchName, sprintPilotTicketTail, sprintPilotWorktreeAddArgs } from "./sprintpilot-server.ts";

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
