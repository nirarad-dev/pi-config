import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./SprintPilot.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/sprintpilot/worktree/route.ts", import.meta.url), "utf8");

test("offers the three named worktree sources and a browsed repository", () => {
  for (const source of ["arnac", "fordicode", "workflows"]) {
    assert.match(route, new RegExp(`id: "${source}"`));
  }
  assert.match(component, /<b>OTHER<\/b>/);
  assert.match(component, /<DirectoryPicker/);
});

test("passes the selected source or browsed repository to worktree creation", () => {
  assert.match(component, /createWorktree\(\{ source: source\.id \}\)/);
  assert.match(component, /createWorktree\(\{ repoRoot \}\)/);
  assert.match(route, /sprintPilotBranchName\(key,/);
  assert.match(route, /`\$\{basename\(repo\)\}-\$\{ticketTail\}`/);
  assert.match(route, /matchingSprintPilotBranch\(localBranches, requestedBranch\)/);
});
