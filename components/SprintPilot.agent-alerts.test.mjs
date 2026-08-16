import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SprintPilot.tsx", import.meta.url), "utf8");

test("polls each task-scoped session for completion and input requests", () => {
  assert.match(source, /taskRuntime\.sessionId \? \[\{ key, sessionId: taskRuntime\.sessionId \}\]/);
  assert.match(source, /\/api\/sprintpilot\/agent-status\?ids=/);
  assert.match(source, /snapshot\.needsUserInput/);
  assert.match(source, /lastPromptFinishedAt/);
  assert.match(source, /setInterval\(pollAgentStates, 2_000\)/);
});

test("renders the alert on its relevant Jira ticket card", () => {
  assert.match(source, /agentAlerts\[item\.key\]/);
  assert.match(source, /INPUT NEEDED/);
  assert.match(source, /AGENT FINISHED/);
  assert.match(source, /clearFinishedAlert\(key\)/);
});
