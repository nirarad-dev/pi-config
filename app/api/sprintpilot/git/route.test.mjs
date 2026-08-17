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
  assert.doesNotMatch(route, /action === "approve"/);
  assert.match(route, /generatedBy: "fallback"/);
});

test("the staged set comes from Git, never from the request", () => {
  // The operator curates the index with the stage/unstage controls; a client
  // file list could otherwise widen what gets committed.
  assert.doesNotMatch(route, /snapshotChanges\(cwd, body\.files\)/);
  assert.match(route, /const \{ staged \} = await stagedAndUnstaged\(cwd\)/);
  assert.match(route, /Stage at least one file before drafting a commit message/);
});

test("commit records the index and refuses a staged set that moved", () => {
  assert.match(route, /staged\.join\("\\n"\) !== approval\.files\.join\("\\n"\)/);
  assert.match(route, /The staged files changed since you reviewed them/);
  // No re-staging at commit time: that would absorb edits made after drafting.
  assert.match(route, /"commit", "-m", message/);
  assert.doesNotMatch(route, /"add", "-f", "--", \.\.\.approval\.files/);
});

test("staging only accepts paths Git reports as changed", () => {
  assert.match(route, /action === "stage" \|\| action === "unstage"/);
  assert.match(route, /const changed = await changedPaths\(cwd\)/);
  assert.match(route, /Git does not report these files as changed/);
});

test("unstaging uses restore --staged and staging forces only on request", () => {
  assert.match(route, /"restore", "--staged", "--"/);
  assert.match(route, /body\.force === true \? \["-f"\] : \[\]/);
  assert.match(route, /ignored by one of your \\\.gitignore files/);
  assert.match(route, /ignored: true/);
});
