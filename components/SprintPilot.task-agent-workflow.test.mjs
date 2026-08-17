import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sprintPilot = readFileSync(new URL("./SprintPilot.tsx", import.meta.url), "utf8");
const appShell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("workflow shortcuts reuse the task chat and queue behind active work", () => {
  assert.match(sprintPilot, /const ensureTaskSession = async/);
  assert.match(sprintPilot, /sendAgentCommand\(sessionId, \{ type: "prompt", message, streamingBehavior: "followUp" \}\)/);
  assert.match(sprintPilot, /A manually deleted\/expired session should not strand this Jira task/);
  assert.match(sprintPilot, /QUEUE IN TASK CHAT/);
  assert.doesNotMatch(sprintPilot, /AUTONOMOUS WORK/);
});

test("the scoped embedded chat reports its selected session to SprintPilot", () => {
  assert.match(appShell, /window\.parent\.postMessage\(\{/);
  assert.match(appShell, /type: "session-selected"/);
  assert.match(sprintPilot, /data\.type !== "session-selected"/);
  assert.match(sprintPilot, /updateRuntime\(\{ sessionId: data\.sessionId \}\)/);
});
