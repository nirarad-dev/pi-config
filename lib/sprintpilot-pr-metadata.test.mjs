import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sprintpilot-pr-metadata.ts", import.meta.url), "utf8");

test("fallback PR metadata follows the repository template", () => {
  assert.match(source, /\[\$\{component\}\] \[\$\{taskKey\}\]/);
  assert.match(source, /## Description/);
  assert.match(source, /## Tickets/);
  assert.match(source, /sprintPilotJiraUrl/);
  assert.match(source, /withLinkedSprintPilotTicket/);
  assert.match(source, /🤖 Generated with \[Claude Code\]/);
  assert.match(source, /Jira details/);
});
