import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sprintpilot-jira-links.ts", import.meta.url), "utf8");

test("Jira PR checks use native Development data rather than remote links", () => {
  assert.match(source, /development\[pullrequests\]\.all > 0/);
  assert.match(source, /\/rest\/api\/3\/search\/jql/);
  assert.doesNotMatch(source, /\/remotelink/);
  assert.match(source, /state: "linked"/);
  assert.match(source, /state: "pending"/);
  assert.match(source, /Could not reach Jira to verify the Development link/);
});
