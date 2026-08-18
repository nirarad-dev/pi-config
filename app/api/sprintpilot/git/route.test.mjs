import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("pull-request creation enforces the repository title and description contract", () => {
  assert.match(route, /PR title must use the repository format: \[Component\] \[DEV-12345\] Short description/);
  assert.match(route, /description\.includes\("## Description"\)/);
  // Both Tickets spellings are recognized, and the body's own heading is kept.
  assert.match(route, /ticketsSection\(description\)/);
  assert.match(route, /must contain \$\{taskKey\} as bare text/);
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

test("the Tickets section must carry the key as bare text, not only a link", () => {
  // The shape that produced a PR Jira never showed: the key existed only as a
  // Markdown link target, which the text scraper does not reliably read.
  assert.match(route, /hasBareJiraKey\(tickets, taskKey\)/);
  assert.match(route, /A Markdown link alone is not read by GitHub for Jira/);
});

test("issue-key lookalikes in the title or branch are refused before creation", () => {
  assert.match(route, /findStrayJiraKeys\(title, \[taskKey\]\)/);
  assert.match(route, /findStrayJiraKeys\(branch, \[taskKey\]\)/);
  assert.match(route, /latest_release_minus_1/);
});

test("an atlOrigin footer is never authored into the body", () => {
  assert.match(route, /findInjectedJiraFooters\(description\)/);
  assert.match(route, /adds that itself after ingest/);
});

test("creation reports the three scraped surfaces and links the ticket", () => {
  // Branch and title are checked before the PR exists and can be refused; a
  // commit message is history, so it is reported rather than repaired.
  assert.match(route, /commitCarriesKey/);
  assert.match(route, /createSprintPilotJiraRemoteLink\(taskKey, url, title\)/);
});

test("ingest is verified by polling, with a bare-key comment as the nudge", () => {
  assert.match(route, /action === "jira-development"/);
  assert.match(route, /action === "jira-nudge"/);
  // The comment body is the bare key and nothing else.
  assert.match(route, /"pr", "comment", url, "--body", taskKey/);
});
