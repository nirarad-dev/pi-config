import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("pull-request creation enforces the repository title and description contract", () => {
  assert.match(route, /PR title must use the repository format: \[Component\] \[DEV-12345\] Short description/);
  assert.match(route, /description\.includes\("## Description"\)/);
  assert.match(route, /description\.includes\("## Tickets"\)/);
  assert.match(route, /PR Tickets must link to the Jira issue that appears in the title/);
  assert.match(route, /checkSprintPilotPullRequestInJira/);
  assert.match(route, /PR title Jira key .* must match branch Jira key/);
  assert.match(route, /--assignee", "@me"/);
  assert.match(route, /appendArnacAiDisclosure\(description\)/);
});

test("push enforces the GitHub for Atlassian branch trigger", () => {
  assert.match(route, /Branch must contain its Jira key before push/);
  assert.match(route, /git", \["push", "--set-upstream", "origin", branch\]/);
});

test("commit-message generation uses the task session and retains a snapshot fallback", () => {
  assert.match(route, /generateSprintPilotCommitMessage/);
  assert.match(route, /taskDescription/);
  assert.match(route, /snapshotChanges\(cwd, body\.files\)/);
  assert.doesNotMatch(route, /action === "approve"/);
  assert.match(route, /generatedBy: "fallback"/);
  assert.match(route, /Changes moved since approval/);
});
