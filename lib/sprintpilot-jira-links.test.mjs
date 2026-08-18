import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sprintpilot-jira-links.ts", import.meta.url), "utf8");

test("only native Development data counts as Jira having seen the pull request", () => {
  assert.match(source, /development\[pullrequests\]\.all > 0/);
  assert.match(source, /\/rest\/api\/3\/search\/jql/);
  assert.match(source, /state: "linked"/);
  assert.match(source, /state: "pending"/);
  assert.match(source, /Could not reach Jira to verify the Development link/);
});

test("a remote link is created as the visible fallback, never as the signal", () => {
  // A remote link shows under issue links and creates none of the branch/PR
  // association, so it cannot stand in for Development data. It is what leaves
  // a clickable link on the ticket when ingest silently does not happen.
  assert.match(source, /\/rest\/api\/3\/issue\/\$\{encodeURIComponent\(taskKey\)\}\/remotelink/);
  assert.match(source, /globalId/);
  const check = source.slice(source.indexOf("export async function checkSprintPilotPullRequestInJira"));
  assert.doesNotMatch(check, /remotelink/, "the Development check must not consult remote links");
});
