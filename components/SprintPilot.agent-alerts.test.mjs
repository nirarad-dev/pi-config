import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SprintPilot.tsx", import.meta.url), "utf8");

test("polls each task-scoped session for completion and input requests", () => {
  assert.match(source, /taskRuntime\.sessionId \? \[\{ key, sessionId: taskRuntime\.sessionId \}\]/);
  assert.match(source, /\/api\/sprintpilot\/agent-status\?ids=/);
  assert.match(source, /snapshot\.needsUserInput/);
  assert.match(source, /snapshot\.queued/);
  assert.match(source, /lastPromptFinishedAt/);
  assert.match(source, /setInterval\(pollAgentStates, 2_000\)/);
});

test("renders the alert on its relevant Jira ticket card", () => {
  assert.match(source, /agentAlerts\[item\.key\]/);
  assert.match(source, /AGENT_RAIL_STATUS/);
  assert.match(source, /NEEDS INPUT/);
  assert.match(source, /WORKING/);
  assert.match(source, /QUEUED/);
  assert.match(source, /AWAITING YOU/);
  assert.match(source, /IDLE/);
});

test("an alert survives opening the task and clears only when the agent is answered", () => {
  // Opening the tab is how the operator reads what the agent said, so it must
  // not dismiss the signal; sending a prompt is the act that resolves it.
  const openTask = source.slice(source.indexOf("const openTask ="), source.indexOf("const handleFlowStep"));
  assert.doesNotMatch(openTask, /clearAgentAlert/);
  const queuePrompt = source.slice(source.indexOf("const queueTaskPrompt ="), source.indexOf("const sendWorkflowPrompt"));
  assert.match(queuePrompt, /clearAgentAlert\(activeKey\)/);
});

test("the rail summarizes every task still awaiting a reply", () => {
  assert.match(source, /awaitingKeys/);
  assert.match(source, /AWAITING YOU<\/b>/);
  assert.match(source, /openTask\(awaitingKeys\[0\]\)/);
});
